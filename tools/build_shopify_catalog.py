#!/usr/bin/env python3
"""
Shopify未掲載（status=UNLISTED）商品132件をカタログ化する。

products_data.js に既存の shopify GID があれば、その HP商品IDをカタログID（alias）として
引き継ぐ（URL互換維持）。既存の HP商品IDが見つからない商品は "shopify_{数値ID}" を
カタログIDとして新規採番する。

Usage:
    python tools/build_shopify_catalog.py --dry-run   # 検証結果のみ表示。書き込みなし
    python tools/build_shopify_catalog.py             # products_catalog.generated.js を生成

products_data.js は一切書き換えない（読み取りのみ）。Shopifyへの書き込みは行わない。
Admin APIトークンは在庫ソフト側の .env からのみ読み込み、生成物・ログへは一切出力しない。
"""
import argparse
import html.parser
import json
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
REPO_DIR = TOOLS_DIR.parent
PRODUCTS_DATA_PATH = REPO_DIR / "products_data.js"
OUTPUT_PATH = REPO_DIR / "products_catalog.generated.js"
ADMIN_ENV_PATH = Path(r"C:\Users\butay\claude code\inventory\.env")

SHOPIFY_DOMAIN = "vh55x1-pa.myshopify.com"
SHOPIFY_ADMIN_API_VERSION = "2026-01"
SCHEMA_VERSION = 1
MAX_VARIANTS_PER_PRODUCT = 50

# fika センタースモッキング半袖OP は products_sync.js 時代からこのIDでHPに存在していたため、
# 通常の shopify GID 突合では見つからない（products_data.js にエントリがないため）。
# URL互換維持のため、既存IDとして明示的に固定する。
LEGACY_ALIAS_OVERRIDES = {
    "gid://shopify/Product/8452790157498": "sp_8452790157498",
}

# 許可するHTMLタグのみを残す簡易サニタイザ（許可タグ方式）。
ALLOWED_TAGS = {"p", "br", "strong", "b", "em", "i", "ul", "ol", "li", "span"}
# これらのタグの中身は、タグ自体だけでなく内部のテキストも除去する
# （<script>...</script> のようなタグの中身が「可視テキスト」として漏れ出るのを防ぐため）。
RAW_CONTENT_TAGS = {"script", "style", "noscript", "iframe", "object", "template"}


class DescriptionSanitizer(html.parser.HTMLParser):
    """Shopifyの商品説明HTMLから許可タグ以外を除去する（許可タグ方式のサニタイズ）。
    style/onclick等の属性はすべて落とし、スクリプト・イベントハンドラの混入を防ぐ。
    script/style等のタグは中身のテキストごと除去する（コメント同様に「見えない」ものとして扱う）。"""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []
        self.skip_stack = []

    def handle_starttag(self, tag, attrs):
        if tag in RAW_CONTENT_TAGS:
            self.skip_stack.append(tag)
            return
        if self.skip_stack:
            return
        if tag in ALLOWED_TAGS:
            self.out.append(f"<{tag}>")

    def handle_startendtag(self, tag, attrs):
        if self.skip_stack:
            return
        if tag in ALLOWED_TAGS:
            self.out.append(f"<{tag}></{tag}>")

    def handle_endtag(self, tag):
        if self.skip_stack:
            if tag == self.skip_stack[-1]:
                self.skip_stack.pop()
            return
        if tag in ALLOWED_TAGS:
            self.out.append(f"</{tag}>")

    def handle_data(self, data):
        if self.skip_stack:
            return
        self.out.append(html_escape_text(data))

    def get_html(self):
        return "".join(self.out)


def html_escape_text(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def sanitize_description(raw_html):
    if not raw_html:
        return ""
    parser = DescriptionSanitizer()
    parser.feed(raw_html)
    return parser.get_html()


def visible_text_is_empty(sanitized_html):
    """サニタイズ後のHTMLからタグを除去し、可視文字（空白以外）が1文字も
    残らない場合に空とみなす。&nbsp;等の非改行スペースのみの場合も空扱いとする。"""
    text = re.sub(r"<[^>]*>", "", sanitized_html or "")
    text = text.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    return text.strip() == ""


class CatalogError(Exception):
    pass


def read_admin_token():
    if not ADMIN_ENV_PATH.exists():
        raise CatalogError(f".env が見つかりません: {ADMIN_ENV_PATH}")
    with open(ADMIN_ENV_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line.startswith("SHOPIFY_ADMIN_TOKEN="):
                token = line.split("=", 1)[1].strip()
                if token:
                    return token
    raise CatalogError("SHOPIFY_ADMIN_TOKEN が .env に見つかりません")


def admin_graphql(token, query, variables=None):
    endpoint = f"https://{SHOPIFY_DOMAIN}/admin/api/{SHOPIFY_ADMIN_API_VERSION}/graphql.json"
    body = json.dumps({"query": query, "variables": variables or {}}).encode("utf-8")
    req = urllib.request.Request(
        endpoint, data=body, method="POST",
        headers={"Content-Type": "application/json", "X-Shopify-Access-Token": token},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError) as e:
        raise CatalogError(f"Shopify Admin API通信エラー: {e}")
    if "errors" in data:
        raise CatalogError(f"Shopify Admin APIエラー: {data['errors']}")
    return data["data"]


PUBLICATIONS_QUERY = "query { publications(first: 25) { edges { node { id name } } } }"

PRODUCTS_QUERY = """
query($cursor: String, $headlessId: ID!) {
  products(first: 100, after: $cursor, query: "status:unlisted") {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        title
        status
        vendor
        productType
        descriptionHtml
        updatedAt
        images(first: 20) { edges { node { url altText } } }
        variants(first: 60) {
          edges {
            node {
              id
              title
              availableForSale
              selectedOptions { name value }
              price
            }
          }
        }
        headlessPublished: publishedOnPublication(publicationId: $headlessId)
      }
    }
  }
}
"""


def resolve_headless_publication(token):
    """Headless publicationを一意に特定する。0件・複数候補はいずれも停止（呼び出し側でCatalogErrorへ変換）。
    resourcePublications(first:N)のような先頭範囲取得には依存せず、publication ID による
    publishedOnPublication直接判定を後続クエリで使用する。"""
    data = admin_graphql(token, PUBLICATIONS_QUERY)
    pubs = [e["node"] for e in data["publications"]["edges"]]
    candidates = [p for p in pubs if "headless" in p["name"].lower()]
    if len(candidates) == 0:
        raise CatalogError("Headless publicationが見つかりません（0件）。生成を中止します。")
    if len(candidates) > 1:
        names = ", ".join(f"{c['name']} ({c['id']})" for c in candidates)
        raise CatalogError(f"Headless publicationの候補が複数あり一意に決定できません: {names}")
    return candidates[0]


def fetch_unlisted_products(token, headless_publication_id):
    products = []
    cursor = None
    while True:
        data = admin_graphql(token, PRODUCTS_QUERY, {"cursor": cursor, "headlessId": headless_publication_id})
        page = data["products"]
        products.extend(e["node"] for e in page["edges"])
        if not page["pageInfo"]["hasNextPage"]:
            break
        cursor = page["pageInfo"]["endCursor"]
    return products


def load_existing_hp_ids():
    """products_data.js を読み取り専用で Node.js に実行させ、shopify GID -> HP商品ID の
    対応表を取得する（正規表現による自前パースはブロック境界の誤検出リスクがあるため、
    実際の構文解析をJSエンジン自身に委ねる）。products_data.js 自体は一切書き換えない。"""
    import subprocess
    script = (
        "global.window = {};"
        f"require({json.dumps(str(PRODUCTS_DATA_PATH))});"
        "var d = window.PRODUCTS_DATA;"
        "var out = {};"
        "for (var k in d) { if (d[k].shopify) out[d[k].shopify] = k; }"
        "console.log(JSON.stringify(out));"
    )
    try:
        result = subprocess.run(
            ["node", "-e", script], capture_output=True, text=True, encoding="utf-8", check=True, timeout=30
        )
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        raise CatalogError(f"products_data.js の読み取りに失敗しました（Node.js実行エラー）: {e}")
    return json.loads(result.stdout)


def numeric_id_from_gid(gid):
    m = re.search(r"/(\d+)$", gid)
    if not m:
        raise CatalogError(f"GID形式が不正です: {gid}")
    return m.group(1)


def build_catalog_entries(products, variant_to_hp_id):
    entries = []
    seen_product_gids = set()
    seen_variant_gids = set()
    not_headless_published = []
    empty_description = []

    for p in products:
        if p["status"] != "UNLISTED":
            raise CatalogError(f"UNLISTED以外の商品が混入しています: {p['id']} status={p['status']}")

        if p["id"] in seen_product_gids:
            raise CatalogError(f"Product GIDが重複しています: {p['id']}")
        seen_product_gids.add(p["id"])

        variants_raw = [e["node"] for e in p["variants"]["edges"]]
        if len(variants_raw) > MAX_VARIANTS_PER_PRODUCT:
            raise CatalogError(
                f"バリエーション数が上限({MAX_VARIANTS_PER_PRODUCT})を超えています: "
                f"{p['id']} ({p['title']}) = {len(variants_raw)}件。全件取得できないため停止します。"
            )
        if not variants_raw:
            raise CatalogError(f"バリエーションが0件の商品があります: {p['id']} ({p['title']})")

        for v in variants_raw:
            if v["id"] in seen_variant_gids:
                raise CatalogError(f"Variant GIDが重複しています: {v['id']}")
            seen_variant_gids.add(v["id"])

        if not p["title"]:
            raise CatalogError(f"商品名が空です: {p['id']}")
        images = [e["node"]["url"] for e in p["images"]["edges"]]
        if not images:
            raise CatalogError(f"画像が0件の商品があります: {p['id']} ({p['title']})")

        if p["headlessPublished"] is not True:
            not_headless_published.append((p["id"], p["title"]))

        sanitized_desc = sanitize_description(p["descriptionHtml"])
        if visible_text_is_empty(sanitized_desc):
            empty_description.append((p["id"], p["title"]))

        # alias（既存HP商品ID）の解決: 手動オーバーライド優先 → variant GID突合
        # ※ alias は URL/カタログID の互換維持のみに用いる。商品タイトルの上書きには一切使わない。
        alias = LEGACY_ALIAS_OVERRIDES.get(p["id"])
        if not alias:
            matched = set()
            for v in variants_raw:
                hp_id = variant_to_hp_id.get(v["id"])
                if hp_id:
                    matched.add(hp_id)
            if len(matched) > 1:
                raise CatalogError(
                    f"既存HP商品IDが複数のShopify商品へ対応しています: {p['id']} -> {matched}"
                )
            alias = next(iter(matched), None)

        numeric_id = numeric_id_from_gid(p["id"])
        catalog_id = alias if alias else f"shopify_{numeric_id}"
        representative_variant = variants_raw[0]["id"]

        product_type = p["productType"] if p["productType"] else "Other"

        # 商品タイトルはShopify Product.titleをそのまま正本として保持する。
        # name は内部互換のため同じ値を複製するだけで、既存HPの手入力名では一切上書きしない。
        entries.append({
            "catalogId": catalog_id,
            "productGid": p["id"],
            "representativeVariantGid": representative_variant,
            "shopifyTitle": p["title"],
            "name": p["title"],
            "descriptionHtml": sanitized_desc,
            "vendor": p["vendor"] or "",
            "productType": product_type,
            "images": images,
            "variants": [
                {
                    "gid": v["id"],
                    "title": v["title"],
                    "selectedOptions": v["selectedOptions"],
                    "price": v["price"],
                    "currencyCode": "JPY",
                    "availableForSale": v["availableForSale"],
                }
                for v in variants_raw
            ],
            "shopifyStatus": p["status"],
            "headlessPublished": p["headlessPublished"] is True,
            "existingAlias": alias,
            "updatedAt": p["updatedAt"],
        })

    if not_headless_published:
        listing = "\n".join(f"  - {title} ({gid})" for gid, title in not_headless_published)
        raise CatalogError(
            f"Headless未公開のUNLISTED商品が{len(not_headless_published)}件あります。生成を中止します。\n{listing}"
        )

    if empty_description:
        listing = "\n".join(f"  - {title} ({gid})" for gid, title in empty_description)
        raise CatalogError(
            f"商品説明が空（サニタイズ後に可視文字なし）の商品が{len(empty_description)}件あります。"
            f"生成を中止します。\n{listing}"
        )

    # 並び順を固定: updatedAt 昇順 → 同値時は productGid 昇順（同一データからは常に同じ順序）
    entries.sort(key=lambda e: (e["updatedAt"], e["productGid"]))
    return entries


def validate(entries):
    errors = []
    if len(entries) != 132:
        errors.append(f"生成件数が132件ではありません: {len(entries)}件")

    product_gids = [e["productGid"] for e in entries]
    if len(product_gids) != len(set(product_gids)):
        errors.append("Product GIDに重複があります")

    variant_gids = [v["gid"] for e in entries for v in e["variants"]]
    if len(variant_gids) != len(set(variant_gids)):
        errors.append("Variant GIDに重複があります")
    if len(variant_gids) != 286:
        errors.append(f"Variant GID総数が286件ではありません: {len(variant_gids)}件")

    for e in entries:
        if e["shopifyStatus"] != "UNLISTED":
            errors.append(f"DRAFT等の非UNLISTED商品が混入: {e['productGid']}")
        if not e["name"]:
            errors.append(f"商品名が空: {e['productGid']}")
        if e["name"] != e["shopifyTitle"]:
            errors.append(f"name が shopifyTitle と一致しません: {e['productGid']}")
        if visible_text_is_empty(e["descriptionHtml"]):
            errors.append(f"商品説明が空（可視文字なし）: {e['productGid']}")
        if not e["images"]:
            errors.append(f"画像が空: {e['productGid']}")
        if e["headlessPublished"] is not True:
            errors.append(f"Headless未公開の商品が混入: {e['productGid']}")

    aliased = [e for e in entries if e["existingAlias"]]
    if len(aliased) != 89:
        errors.append(f"既存alias件数が89件ではありません: {len(aliased)}件")
    new_ones = [e for e in entries if not e["existingAlias"]]
    if len(new_ones) != 43:
        errors.append(f"新規商品件数が43件ではありません: {len(new_ones)}件")

    no_type = [e for e in entries if e["productType"] == "Other"]
    if len(no_type) < 2:
        errors.append("productType未設定2商品のOther扱いが確認できません")

    multi_variant = [e for e in entries if len(e["variants"]) > 1]
    if len(multi_variant) < 40:
        errors.append(f"複数バリエーション商品数が想定より少ない: {len(multi_variant)}件")

    return errors


def js_string_literal(s):
    return json.dumps(s, ensure_ascii=False)


def render_js(entries, generated_at):
    lines = []
    lines.append("// ===== 自動生成ファイル — 手編集禁止 =====")
    lines.append("// tools/build_shopify_catalog.py が Shopify Admin API (status:UNLISTED) から生成。")
    lines.append(f"// 最終生成日時: {generated_at}")
    lines.append("(function () {")
    lines.append("  var CATALOG = {")
    lines.append(f"    schemaVersion: {SCHEMA_VERSION},")
    lines.append(f"    generatedAt: {js_string_literal(generated_at)},")
    lines.append("    products: [")
    for e in entries:
        lines.append("      {")
        lines.append(f"        catalogId: {js_string_literal(e['catalogId'])},")
        lines.append(f"        productGid: {js_string_literal(e['productGid'])},")
        lines.append(f"        representativeVariantGid: {js_string_literal(e['representativeVariantGid'])},")
        lines.append(f"        shopifyTitle: {js_string_literal(e['shopifyTitle'])},")
        lines.append(f"        name: {js_string_literal(e['name'])},")
        lines.append(f"        descriptionHtml: {js_string_literal(e['descriptionHtml'])},")
        lines.append(f"        vendor: {js_string_literal(e['vendor'])},")
        lines.append(f"        productType: {js_string_literal(e['productType'])},")
        lines.append(f"        images: {json.dumps(e['images'], ensure_ascii=False)},")
        variants_json = json.dumps(e["variants"], ensure_ascii=False)
        lines.append(f"        variants: {variants_json},")
        lines.append(f"        shopifyStatus: {js_string_literal(e['shopifyStatus'])},")
        lines.append(f"        headlessPublished: {'true' if e['headlessPublished'] else 'false'},")
        lines.append(f"        existingAlias: {js_string_literal(e['existingAlias']) if e['existingAlias'] else 'null'},")
        lines.append(f"        updatedAt: {js_string_literal(e['updatedAt'])}")
        lines.append("      },")
    lines.append("    ]")
    lines.append("  };")
    lines.append("  window.SHOPIFY_CATALOG = CATALOG;")
    lines.append("})();")
    lines.append("")
    return "\n".join(lines)


def atomic_write(path, content):
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(content, encoding="utf-8")
    tmp_path.replace(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="検証結果のみ表示。書き込みなし")
    args = parser.parse_args()

    try:
        token = read_admin_token()
        variant_to_hp_id = load_existing_hp_ids()
        headless_pub = resolve_headless_publication(token)
        products = fetch_unlisted_products(token, headless_pub["id"])
        entries = build_catalog_entries(products, variant_to_hp_id)
    except CatalogError as e:
        print(f"エラー: {e}", file=sys.stderr)
        sys.exit(1)

    errors = validate(entries)
    if errors:
        print("検証失敗。生成ファイルは書き換えません。", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)

    aliased_count = sum(1 for e in entries if e["existingAlias"])
    new_count = len(entries) - aliased_count
    print(f"検証OK: 全{len(entries)}件（既存alias {aliased_count}件 / 新規 {new_count}件）")
    print(f"Variant総数: {sum(len(e['variants']) for e in entries)}件")

    if args.dry_run:
        print("\n--dry-run のため products_catalog.generated.js への書き込みは行いません。")
        return

    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    content = render_js(entries, generated_at)
    atomic_write(OUTPUT_PATH, content)
    print(f"\n{OUTPUT_PATH.name} を生成しました。")


if __name__ == "__main__":
    main()
