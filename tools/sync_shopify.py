#!/usr/bin/env python3
"""
指示書16 フェーズB: Shopify公開商品 -> products_sync.js の自動生成・同期。

Usage:
    python tools/sync_shopify.py --dry-run    # 同期対象一覧を表示するのみ。書き込み・デプロイなし
    python tools/sync_shopify.py --no-deploy  # products_sync.js は書き換えるがdeployしない
    python tools/sync_shopify.py              # 本実行（変更があれば products_sync.js 更新 + deploy.py 実行）

products_data.js は一切書き換えない。同期結果はすべて products_sync.js（自動生成・毎回丸ごと再生成）に出力する。
"""
import argparse
import json
import re
import subprocess
import sys
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
REPO_DIR = TOOLS_DIR.parent
PRODUCTS_DATA_PATH = REPO_DIR / "products_data.js"
PRODUCTS_SYNC_PATH = REPO_DIR / "products_sync.js"
LOG_PATH = TOOLS_DIR / "sync_shopify_log.txt"
DEPLOY_SCRIPT = REPO_DIR / "deploy.py"

SHOPIFY_DOMAIN = "vh55x1-pa.myshopify.com"
SHOPIFY_API_VERSION = "2026-01"
SHOPIFY_STOREFRONT_TOKEN = "21acdc860f5b978a395b0e1e387aef0e"

# 保留リスト: HPに手動ページが既にある未紐付け商品（二重ページ防止）
HOLD_LIST = {"46128213033146", "46128230629562", "46128572334266"}

# ponytail: Shopify側でこの店の商品はほぼ全件が同一の汎用vendor値。
# vendor=artistという前提が成立しないため、この値の時だけタイトル先頭の
# 作家名を使う。実カタログにこれ以外の値が増えたら都度確認すること。
GENERIC_VENDOR = "マイストア"

QUERY = """
query($cursor: String) {
  products(first: 250, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        title
        vendor
        description
        productType
        createdAt
        images(first: 10) { edges { node { url } } }
        variants(first: 50) { edges { node { id title availableForSale price { amount } } } }
      }
    }
  }
}
"""


class SyncError(Exception):
    pass


def fetch_all_products():
    endpoint = f"https://{SHOPIFY_DOMAIN}/api/{SHOPIFY_API_VERSION}/graphql.json"
    products = []
    cursor = None
    while True:
        body = json.dumps({"query": QUERY, "variables": {"cursor": cursor}}).encode("utf-8")
        req = urllib.request.Request(
            endpoint, data=body, method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Shopify-Storefront-Access-Token": SHOPIFY_STOREFRONT_TOKEN,
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError) as e:
            raise SyncError(f"Shopify API取得失敗: {e}")
        if "errors" in data:
            raise SyncError(f"Shopify APIエラー: {data['errors']}")
        page = data["data"]["products"]
        products.extend(e["node"] for e in page["edges"])
        if not page["pageInfo"]["hasNextPage"]:
            break
        cursor = page["pageInfo"]["endCursor"]
    return products


def extract_existing_gids(products_data_src):
    return set(re.findall(r"gid://shopify/ProductVariant/\d+", products_data_src))


def strip_vendor_prefix(title, vendor):
    """titleの先頭からvendorを除去（NFKC正規化・空白無視で比較）。一致しなければtitleのまま。"""
    vendor_chars = re.sub(r"\s+", "", unicodedata.normalize("NFKC", vendor))
    if not vendor_chars:
        return title
    idx, vi = 0, 0
    while idx < len(title) and vi < len(vendor_chars):
        c = title[idx]
        if c.isspace():
            idx += 1
            continue
        if unicodedata.normalize("NFKC", c) != vendor_chars[vi]:
            return title
        idx += 1
        vi += 1
    if vi < len(vendor_chars):
        return title
    while idx < len(title) and title[idx].isspace():
        idx += 1
    rest = title[idx:]
    return rest if rest else title


def resolve_artist_and_name(title, vendor):
    title = title.strip()
    vendor = vendor.strip()
    if vendor == GENERIC_VENDOR:
        m = re.match(r"^(\S+)[ 　\t]+(.+)$", title)
        if m:
            return m.group(1), m.group(2).strip()
        return vendor, title
    return vendor, strip_vendor_prefix(title, vendor)


def build_entry(node):
    variants = [e["node"] for e in node["variants"]["edges"]]
    available = [v for v in variants if v["availableForSale"]]
    chosen_variant = available[0] if available else variants[0]
    artist, name = resolve_artist_and_name(node["title"], node["vendor"])
    images = [e["node"]["url"] for e in node["images"]["edges"]]
    return {
        "artist": artist,
        "name": name,
        "price": int(float(variants[0]["price"]["amount"])),
        "category": node["productType"] or "",
        "description": node["description"] or "",
        "img": images[0] if images else "",
        "images": images,
        "shopify": chosen_variant["id"],
        "soldout": not available,
    }


def numeric_id(gid):
    return gid.rsplit("/", 1)[-1]


def collect_new_products(all_products, existing_gids):
    new_products = []
    for node in all_products:
        variant_gids = {v["node"]["id"] for v in node["variants"]["edges"]}
        if variant_gids & existing_gids:
            continue
        if any(numeric_id(g) in HOLD_LIST for g in variant_gids):
            continue
        new_products.append(node)
    return new_products


def split_by_images(new_products):
    """指示書17: 画像が1枚も無い商品は同期対象から除外し、画像登録後の次回同期に回す。"""
    with_images = [n for n in new_products if n["images"]["edges"]]
    no_images = [n for n in new_products if not n["images"]["edges"]]
    return with_images, no_images


def format_product_label(node):
    artist, name = resolve_artist_and_name(node["title"], node["vendor"])
    return f"sp_{numeric_id(node['id'])} | {artist} / {name}"


def build_products_sync_js(new_products):
    P = {}
    order_pairs = []
    for node in new_products:
        key = "sp_" + numeric_id(node["id"])
        P[key] = build_entry(node)
        order_pairs.append((node["createdAt"], f"product_{key}.html"))
    order_pairs.sort(key=lambda x: x[0], reverse=True)
    ORDER = [fname for _, fname in order_pairs]

    p_json = json.dumps(P, ensure_ascii=False, indent=2)
    order_json = json.dumps(ORDER, ensure_ascii=False, indent=2)
    timestamp = datetime.now(timezone.utc).isoformat()
    content = (
        "// ===== 自動生成ファイル — 手編集禁止 =====\n"
        f"// tools/sync_shopify.py が Shopify 公開商品から生成。最終更新: {timestamp}\n"
        "(function () {\n"
        f"  var P = {p_json};\n"
        f"  var ORDER = {order_json};\n"
        "  if (!window.PRODUCTS_DATA) return;\n"
        "  Object.keys(P).forEach(function (k) {\n"
        "    if (!window.PRODUCTS_DATA[k]) window.PRODUCTS_DATA[k] = P[k];\n"
        "  });\n"
        "  if (window.PRODUCTS_ORDER) window.PRODUCTS_ORDER = ORDER.concat(window.PRODUCTS_ORDER);\n"
        "})();\n"
    )
    return content, P


TIMESTAMP_LINE_RE = re.compile(r"^// tools/sync_shopify\.py.*$", re.MULTILINE)


def content_equal_ignoring_timestamp(a, b):
    return TIMESTAMP_LINE_RE.sub("", a) == TIMESTAMP_LINE_RE.sub("", b)


def extract_keys(content):
    return set(re.findall(r'"(sp_\d+)":\s*\{', content))


def append_log(lines):
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="対象一覧の表示のみ。書き込み・デプロイなし")
    parser.add_argument("--no-deploy", action="store_true", help="products_sync.js は更新するがdeploy.pyは実行しない")
    args = parser.parse_args()

    now = datetime.now(timezone.utc).isoformat()

    try:
        products_data_src = PRODUCTS_DATA_PATH.read_text(encoding="utf-8")
        existing_gids = extract_existing_gids(products_data_src)
        all_products = fetch_all_products()
    except SyncError as e:
        append_log([f"[{now}] エラー: {e}"])
        print(f"エラー: {e}", file=sys.stderr)
        sys.exit(1)

    candidates = collect_new_products(all_products, existing_gids)
    new_products, no_image_products = split_by_images(candidates)
    skip_lines = [f"画像未登録のためスキップ: {format_product_label(n)}" for n in no_image_products]

    if args.dry_run:
        print(f"Shopify公開商品総数: {len(all_products)}")
        print(f"既存紐付けvariant GID数: {len(existing_gids)}")
        print(f"同期対象（新商品）: {len(new_products)}件")
        for node in new_products:
            print(f"  - {format_product_label(node)}")
        print(f"画像未登録スキップ: {len(no_image_products)}件")
        for line in skip_lines:
            print(f"  - {line}")
        print("\n--dry-run のため products_sync.js は書き換えていません。")
        return

    for line in skip_lines:
        print(line)

    new_content, P = build_products_sync_js(new_products)

    old_content = PRODUCTS_SYNC_PATH.read_text(encoding="utf-8") if PRODUCTS_SYNC_PATH.exists() else ""

    if old_content and content_equal_ignoring_timestamp(old_content, new_content):
        append_log([
            f"[{now}] 変更なし",
            f"Shopify総数: {len(all_products)} / 同期対象: {len(new_products)}件",
            "デプロイ: スキップ（差分なし）",
        ] + skip_lines)
        print("変更なし。products_sync.js は更新していません。デプロイもスキップします。")
        return

    old_keys = extract_keys(old_content)
    new_keys = extract_keys(new_content)
    added_keys = sorted(new_keys - old_keys)
    removed_keys = sorted(old_keys - new_keys)

    PRODUCTS_SYNC_PATH.write_text(new_content, encoding="utf-8")
    print(f"products_sync.js を更新しました（同期対象 {len(new_products)}件）。")

    deploy_ran = False
    deploy_error = ""
    if not args.no_deploy:
        try:
            subprocess.run([sys.executable, str(DEPLOY_SCRIPT)], cwd=str(REPO_DIR), check=True)
            deploy_ran = True
        except subprocess.CalledProcessError as e:
            deploy_error = str(e)
            print(f"deploy.py 実行エラー: {e}", file=sys.stderr)
    else:
        print("--no-deploy のためデプロイをスキップしました。")

    append_log([
        f"[{now}] 更新あり",
        f"Shopify総数: {len(all_products)} / 同期対象: {len(new_products)}件",
        f"新規キー: {added_keys or 'なし'}",
        f"削除キー: {removed_keys or 'なし'}",
        f"デプロイ実行: {'はい' if deploy_ran else ('スキップ（--no-deploy）' if args.no_deploy else 'エラー: ' + deploy_error)}",
    ] + skip_lines)

    if deploy_error:
        sys.exit(1)


if __name__ == "__main__":
    main()
