#!/usr/bin/env python3
"""
指示書19: 在庫管理ソフトの検品済み・在庫あり商品を Shopify に非公開＋タグ付きで一括作成する。
inventory.json / photos/ は読み取り専用。登録済み管理は shopify_register_ledger.json で行う（冪等）。

Usage:
    python tools/register_shopify.py --exhibition "ナツメク" --dry-run
    python tools/register_shopify.py --exhibition "ナツメク"
"""
import argparse
import json
import re
import sys
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import requests

TOOLS_DIR = Path(__file__).resolve().parent
INVENTORY_DIR = Path(r"C:\Users\butay\claude code\inventory")
ENV_PATH = INVENTORY_DIR / ".env"
DEFAULT_INVENTORY_PATH = INVENTORY_DIR / "inventory.json"
PHOTOS_DIR = INVENTORY_DIR / "photos"
LEDGER_PATH = TOOLS_DIR / "shopify_register_ledger.json"
LOG_PATH = TOOLS_DIR / "register_shopify_log.txt"

SHOPIFY_DOMAIN = "vh55x1-pa.myshopify.com"
SHOPIFY_ADMIN_API_VERSION = "2026-01"
MAX_TARGETS = 200
MAX_TITLE_PAGES = 100
MAX_EXISTING_PRODUCT_COUNT = 25000  # MAX_TITLE_PAGES (100) * 250 per page

# --- Shopify公開前ロック（Phase F-04-F01 緊急安全修正） ---
# コード上で固定した真偽値であり、環境変数・.env・CLI引数のいずれからも読み取らない。
# これらのいずれかで解除できる実装、および隠しオプション・テスト用バイパスは意図的に作らない。
# 解除は、店主承認後の別PRでこの定数そのものを変更することでのみ行う。
PRELAUNCH_LOCKED = True
PRELAUNCH_LOCK_REASON_CODE = "SHOPIFY_REGISTRATION_PRELAUNCH_LOCKED"
PRELAUNCH_LOCK_MESSAGE = "Shopify登録は正式公開前のため停止中です。商品・在庫は変更されていません。"


class RegisterError(Exception):
    pass


def enforce_prelaunch_lock():
    """main()の最初の文として呼び出す。inventory読込み・Shopify query/mutation・
    ledgerの読み書きより前に、無条件で非0終了する。token・入力商品・パス等は出力しない。"""
    if PRELAUNCH_LOCKED:
        print(PRELAUNCH_LOCK_MESSAGE, file=sys.stderr)
        print(PRELAUNCH_LOCK_REASON_CODE, file=sys.stderr)
        sys.exit(1)


def read_admin_token():
    if not ENV_PATH.exists():
        raise RegisterError(f".env が見つかりません: {ENV_PATH}")
    with open(ENV_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line.startswith("SHOPIFY_ADMIN_TOKEN="):
                token = line.split("=", 1)[1].strip()
                if token:
                    return token
    raise RegisterError("SHOPIFY_ADMIN_TOKEN が .env に見つかりません")


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
        raise RegisterError(f"Shopify Admin API通信エラー: {e}")
    if "errors" in data:
        raise RegisterError(f"Shopify Admin APIエラー: {data['errors']}")
    return data["data"]


def load_inventory(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load_ledger():
    if LEDGER_PATH.exists():
        with open(LEDGER_PATH, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_ledger(ledger):
    with open(LEDGER_PATH, "w", encoding="utf-8") as f:
        json.dump(ledger, f, ensure_ascii=False, indent=2)


def classify(items, exhibition, ledger):
    targets = []
    excluded = {"uninspected": [], "stock_zero": [], "already_registered": []}
    for item in items:
        if (item.get("exhibition") or "").strip() != exhibition:
            continue
        if not item.get("inspected"):
            excluded["uninspected"].append(item)
        elif not (item.get("stock") or 0) > 0:
            excluded["stock_zero"].append(item)
        elif str(item["id"]) in ledger:
            excluded["already_registered"].append(item)
        else:
            targets.append(item)
    return targets, excluded


def build_title(item):
    supplier = item.get("supplier")
    name = item.get("name")
    if type(supplier) is not str or type(name) is not str:
        raise RegisterError(f"登録対象商品のタイトルが非文字列です: id={item.get('id')}")
    if not supplier.strip() or not name.strip():
        raise RegisterError(f"登録対象商品のタイトルが空です: id={item.get('id')}")
    return f"{supplier}　{name}"



def tax_included_price(item):
    return round(item["retail"] * (1 + item["taxRate"] / 100))


def build_size_line(size):
    w, d = (size.get("width") or "").strip(), (size.get("depth") or "").strip()
    parts = []
    if w and d:
        parts.append(f"{w}cm×{d}cm")
    elif w or d:
        parts.append(f"{w or d}cm")
    if (size.get("diameter") or "").strip():
        parts.append(f"φ{size['diameter']}cm")
    if (size.get("height") or "").strip():
        parts.append(f"h{size['height']}cm")
    line = " / ".join(parts)
    note = (size.get("note") or "").strip()
    if note:
        line = f"{line} {note}".strip() if line else note
    return line


def build_description(item):
    lines = []
    note = (item.get("note") or "").strip()
    if note:
        lines.append(note)
        lines.append("")
    size_line = build_size_line(item.get("size") or {})
    if size_line:
        lines.append("size")
        lines.append(size_line)
        lines.append("")
    lines.append("手仕事による作品のため、個体差がございます。ご理解の上お求めください。")
    return "\n".join(lines).strip()


def normalize_title(t):
    if type(t) is not str:
        raise RegisterError("商品名の入力値が文字列型ではありません")
    n1 = unicodedata.normalize("NFKC", t)
    n2 = n1.strip()
    n3 = re.sub(r"\s+", " ", n2)
    n4 = n3.casefold()
    if not n4:
        raise RegisterError("商品名が空です")
    return n4


ALL_TITLES_QUERY = """
query($cursor: String) {
  products(first: 250, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges { node { title } }
  }
}
"""


def fetch_all_titles(token):
    titles = set()
    cursor = None
    seen_cursors = set()
    page_count = 0
    raw_product_count = 0
    while True:
        data = admin_graphql(token, ALL_TITLES_QUERY, {'cursor': cursor})
        if not isinstance(data, dict):
            raise RegisterError('Shopify GraphQLのレスポンスが辞書型ではありません')
        products = data.get('products')
        if not isinstance(products, dict):
            raise RegisterError('Shopify商品一覧(products)が辞書型ではありません')
        page_info = products.get('pageInfo')
        if not isinstance(page_info, dict):
            raise RegisterError('Shopify商品一覧のpageInfoが辞書型ではありません')
        edges = products.get('edges')
        if not isinstance(edges, list):
            raise RegisterError('Shopify商品一覧のedgesが配列型ではありません')

        # --- このページの edge/node/title を完全に構造検証する（上限判定より先に実施する） ---
        page_titles = []
        for idx, e in enumerate(edges):
            if not isinstance(e, dict):
                raise RegisterError(f'Shopify商品edgeが辞書型ではありません: index={idx}')
            node = e.get('node')
            if not isinstance(node, dict):
                raise RegisterError(f'Shopify商品nodeが辞書型ではありません: index={idx}')
            title = node.get('title')
            if title is None or type(title) is not str:
                raise RegisterError(f'Shopify既存商品のタイトルが非文字列です: index={idx}')
            try:
                norm_t = normalize_title(title)
            except RegisterError as exc:
                if '空' in str(exc):
                    raise RegisterError(f'Shopify既存商品のタイトルが空です: index={idx}')
                raise
            page_titles.append(norm_t)

        if 'hasNextPage' not in page_info:
            raise RegisterError('Shopify商品一覧のhasNextPageが欠落しています')
        has_next = page_info['hasNextPage']
        if type(has_next) is not bool:
            raise RegisterError(f'Shopify商品一覧のhasNextPageがbool型ではありません: {type(has_next).__name__}')

        end_cursor = page_info.get('endCursor')

        if has_next is True:
            if end_cursor is None:
                raise RegisterError('Shopify商品一覧のhasNextPageがTrueですが、endCursorが欠落またはNoneです')
            if type(end_cursor) is not str:
                raise RegisterError(f'Shopify商品一覧のendCursorが文字列型ではありません: {type(end_cursor).__name__}')
            if not end_cursor.strip():
                raise RegisterError('Shopify商品一覧のendCursorが空文字または空白だけです')
            if end_cursor == cursor:
                raise RegisterError('Shopify商品一覧のendCursorが現在のcursorと同一です')
            if end_cursor in seen_cursors:
                raise RegisterError('Shopify商品一覧のendCursorに循環・重複が検出されました')
            seen_cursors.add(end_cursor)

        # --- ページ全体の構造検証が完了し、全件正常と確定した後にのみ上限を判定する ---
        page_count += 1
        if page_count > MAX_TITLE_PAGES:
            raise RegisterError(f'Shopify商品一覧の取得ページ数が上限({MAX_TITLE_PAGES}ページ)を超過しました')
        if has_next is True and page_count >= MAX_TITLE_PAGES:
            raise RegisterError(f'Shopify商品一覧の取得ページ数が上限({MAX_TITLE_PAGES}ページ)に達したため次ページを取得できません')

        raw_product_count += len(edges)
        if raw_product_count > MAX_EXISTING_PRODUCT_COUNT:
            raise RegisterError(f'Shopify既存商品の総件数が上限({MAX_EXISTING_PRODUCT_COUNT}件)を超過しました')

        # --- 上限判定も通過して初めて、このページの結果を確定反映する（不正ページの部分反映は行わない） ---
        titles.update(page_titles)

        if has_next is False:
            break
        cursor = end_cursor
    return titles

def find_duplicates(targets, existing_titles):
    if not isinstance(existing_titles, set):
        raise RegisterError("existing_titlesの構造が不正です（set型ではありません）")
    duplicates = []
    for t in targets:
        title = build_title(t)
        norm_t = normalize_title(title)
        if norm_t in existing_titles:
            duplicates.append(t)
    return duplicates



PRODUCT_CREATE_MUTATION = """
mutation($input: ProductInput!) {
  productCreate(input: $input) {
    product { id variants(first: 1) { edges { node { id inventoryItem { id } } } } }
    userErrors { field message }
  }
}
"""

VARIANT_UPDATE_MUTATION = """
mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    userErrors { field message }
  }
}
"""

LOCATIONS_QUERY = "query { locations(first: 5) { edges { node { id } } } }"

INVENTORY_ACTIVATE_MUTATION = """
mutation($inventoryItemId: ID!, $locationId: ID!) {
  inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
    userErrors { field message }
  }
}
"""

INVENTORY_SET_QUANTITIES_MUTATION = """
mutation($input: InventorySetQuantitiesInput!) {
  inventorySetQuantities(input: $input) {
    userErrors { field message }
  }
}
"""

STAGED_UPLOADS_MUTATION = """
mutation($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}
"""

MEDIA_CREATE_MUTATION = """
mutation($productId: ID!, $media: [CreateMediaInput!]!) {
  productCreateMedia(productId: $productId, media: $media) {
    mediaUserErrors { field message }
  }
}
"""


def get_location_id(token):
    data = admin_graphql(token, LOCATIONS_QUERY)
    return data["locations"]["edges"][0]["node"]["id"]


def upload_photo(token, file_path):
    filename = file_path.name
    size = file_path.stat().st_size
    data = admin_graphql(token, STAGED_UPLOADS_MUTATION, {"input": [{
        "resource": "IMAGE", "filename": filename, "mimeType": "image/jpeg",
        "httpMethod": "POST", "fileSize": str(size),
    }]})
    errs = data["stagedUploadsCreate"]["userErrors"]
    if errs:
        raise RegisterError(f"stagedUploadsCreate errors: {errs}")
    target = data["stagedUploadsCreate"]["stagedTargets"][0]
    form = {p["name"]: p["value"] for p in target["parameters"]}
    with open(file_path, "rb") as f:
        resp = requests.post(target["url"], data=form, files={"file": (filename, f, "image/jpeg")}, timeout=60)
    resp.raise_for_status()
    return target["resourceUrl"]


def register_one(token, item, location_id):
    title = build_title(item)
    price = tax_included_price(item)
    description = build_description(item)

    create_data = admin_graphql(token, PRODUCT_CREATE_MUTATION, {"input": {
        "title": title,
        "vendor": item["supplier"],
        "tags": [item["exhibition"].strip()],
        "status": "ACTIVE",
        "descriptionHtml": description.replace("\n", "<br>"),
    }})
    errs = create_data["productCreate"]["userErrors"]
    if errs:
        raise RegisterError(f"productCreate errors: {errs}")
    product = create_data["productCreate"]["product"]
    product_id = product["id"]
    variant = product["variants"]["edges"][0]["node"]
    variant_id = variant["id"]
    inventory_item_id = variant["inventoryItem"]["id"]

    variant_errs = admin_graphql(token, VARIANT_UPDATE_MUTATION, {
        "productId": product_id,
        "variants": [{"id": variant_id, "price": str(price), "inventoryItem": {"tracked": True}}],
    })["productVariantsBulkUpdate"]["userErrors"]
    if variant_errs:
        raise RegisterError(f"variant update errors: {variant_errs}")

    admin_graphql(token, INVENTORY_ACTIVATE_MUTATION, {
        "inventoryItemId": inventory_item_id, "locationId": location_id,
    })  # 既にactive済みならuserErrorsが返るが無視して続行

    qty_errs = admin_graphql(token, INVENTORY_SET_QUANTITIES_MUTATION, {"input": {
        "reason": "correction", "name": "available", "ignoreCompareQuantity": True,
        "quantities": [{"inventoryItemId": inventory_item_id, "locationId": location_id, "quantity": item["stock"]}],
    }})["inventorySetQuantities"]["userErrors"]
    if qty_errs:
        raise RegisterError(f"set quantities errors: {qty_errs}")

    photo_ids = item.get("photoIds") or []
    if photo_ids:
        resource_urls = []
        for photo_id in photo_ids:
            file_path = PHOTOS_DIR / f"{item['id']}_{photo_id}.jpg"
            if not file_path.exists():
                continue
            resource_urls.append(upload_photo(token, file_path))
        if resource_urls:
            media_errs = admin_graphql(token, MEDIA_CREATE_MUTATION, {
                "productId": product_id,
                "media": [{"originalSource": u, "mediaContentType": "IMAGE"} for u in resource_urls],
            })["productCreateMedia"]["mediaUserErrors"]
            if media_errs:
                raise RegisterError(f"media create errors: {media_errs}")

    return product_id, title, price, len(photo_ids)


def append_log(lines):
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n\n")


def item_label(item):
    return f"{build_title(item)} (id={item['id']})"


def print_duplicate_hard_stop(duplicates, now, exhibition):
    print("登録を停止しました。")
    print("既存Shopify商品と同名の商品が1件以上あります。")
    print("店主による確認が完了するまで登録できません。")
    for it in duplicates:
        print(f"  - {build_title(it)} (id={it['id']})")
    append_log([
        f"[{now}] 企画展: {exhibition} — 重複ハードストップ: {len(duplicates)}件",
        "\n".join(f"  - {item_label(it)}" for it in duplicates),
    ])


def main():
    enforce_prelaunch_lock()
    parser = argparse.ArgumentParser()
    parser.add_argument("--exhibition", required=True, help="企画展名（inventory.jsonのexhibitionと厳密一致）")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--source", default=str(DEFAULT_INVENTORY_PATH), help="inventory.jsonのパス上書き（テスト用）")
    args = parser.parse_args()
    exhibition = args.exhibition.strip()
    now = datetime.now(timezone.utc).isoformat()
    try:
        token = read_admin_token()
        items = load_inventory(args.source)
        # Validate target items in the exhibition batch early
        if not isinstance(items, list):
            raise RegisterError("インベントリデータのルート構造が配列ではありません")
        for idx, item in enumerate(items):
            if not isinstance(item, dict):
                continue
            if (item.get("exhibition") or "").strip() != exhibition:
                continue
            supplier = item.get("supplier")
            name = item.get("name")
            if type(supplier) is not str or type(name) is not str:
                raise RegisterError(f"登録対象商品のタイトルが非文字列です: index={idx}, id={item.get('id')}")
            if not supplier.strip() or not name.strip():
                raise RegisterError(f"登録対象商品のタイトルが空です: index={idx}, id={item.get('id')}")
            title = f"{supplier}　{name}"
            normalize_title(title)
    except (RegisterError, OSError, json.JSONDecodeError) as e:
        append_log([f"[{now}] エラー（企画展: {exhibition}）: {e}"])
        print(f"エラー: {e}", file=sys.stderr)
        sys.exit(1)

    ledger = load_ledger()
    targets, excluded = classify(items, exhibition, ledger)

    try:
        existing_titles = fetch_all_titles(token)
        duplicates = find_duplicates(targets, existing_titles)
    except RegisterError as e:
        append_log([f"[{now}] エラー（企画展: {exhibition}）: {e}"])
        print(f"エラー: {e}", file=sys.stderr)
        sys.exit(1)

    if args.dry_run:
        print(f"企画展: {exhibition}")
        print(f"登録予定: {len(targets)}件")
        for it in targets:
            print(f"  - {build_title(it)} | 作家: {it['supplier']} | ¥{tax_included_price(it)}（税込） | 在庫{it['stock']} | 写真{len(it.get('photoIds') or [])}枚")
        print(f"未検品スキップ: {len(excluded['uninspected'])}件")
        for it in excluded["uninspected"]:
            print(f"  - {item_label(it)}")
        print(f"在庫0スキップ: {len(excluded['stock_zero'])}件")
        for it in excluded["stock_zero"]:
            print(f"  - {item_label(it)}")
        print(f"登録済みスキップ: {len(excluded['already_registered'])}件")
        for it in excluded["already_registered"]:
            print(f"  - {item_label(it)}")
        if duplicates:
            print()
            print_duplicate_hard_stop(duplicates, now, exhibition)
            sys.exit(1)
        print("\n--dry-run のため登録は行っていません。")
        return

    if not targets:
        append_log([f"[{now}] 企画展: {exhibition} — 対象なし（正常終了）"])
        print("対象なし。正常終了します。")
        return

    if len(targets) > MAX_TARGETS:
        head = "\n".join(f"  - {item_label(it)}" for it in targets[:20])
        append_log([
            f"[{now}] エラー（企画展: {exhibition}）: 対象{len(targets)}件が上限{MAX_TARGETS}件を超過。中止しました。",
            f"先頭20件:\n{head}",
        ])
        print(f"エラー: 対象{len(targets)}件が上限{MAX_TARGETS}件を超過。中止します。", file=sys.stderr)
        sys.exit(1)

    if duplicates:
        print_duplicate_hard_stop(duplicates, now, exhibition)
        sys.exit(1)

    location_id = get_location_id(token)
    registered, errors = [], []
    for item in targets:
        try:
            product_id, title, price, photo_count = register_one(token, item, location_id)
        except RegisterError as e:
            errors.append((item, str(e)))
            print(f"  ERR {item_label(item)}: {e}", file=sys.stderr)
            continue
        ledger[str(item["id"])] = {"gid": product_id, "title": title, "registeredAt": now}
        save_ledger(ledger)
        registered.append((item, product_id, price, photo_count))
        print(f"  登録成功: {title} | ¥{price}（税込） | 写真{photo_count}枚 | {product_id}")

    print(f"\n登録成功: {len(registered)}件 / エラー: {len(errors)}件")

    registered_str = "、".join(build_title(item) for item, _, _, _ in registered) or "なし"
    duplicates_str = "、".join(build_title(it) for it in duplicates) or "なし"
    errors_str = "、".join(f"{item_label(it)}: {msg}" for it, msg in errors) or "なし"
    append_log([
        f"[{now}] 企画展: {exhibition}",
        f"登録{len(registered)}件: {registered_str}",
        f"未検品スキップ{len(excluded['uninspected'])}件",
        f"在庫0スキップ{len(excluded['stock_zero'])}件",
        f"登録済みスキップ{len(excluded['already_registered'])}件",
        f"重複警告{len(duplicates)}件: {duplicates_str}",
        f"エラー{len(errors)}件: {errors_str}",
    ])


if __name__ == "__main__":
    main()
