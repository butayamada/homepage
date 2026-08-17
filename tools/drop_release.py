#!/usr/bin/env python3
"""
指示書18: 企画展タグに厳密一致し、在庫あり・未公開の商品だけを一斉公開する。
公開後は sync_shopify.py を実行してHPに反映する。

Usage:
    python tools/drop_release.py --exhibition "ナツメク" --dry-run
    python tools/drop_release.py --exhibition "ナツメク"
    python tools/drop_release.py --exhibition "ナツメク" --no-sync
"""
import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
REPO_DIR = TOOLS_DIR.parent
ENV_PATH = Path(r"C:\Users\butay\claude code\inventory\.env")
LOG_PATH = TOOLS_DIR / "drop_release_log.txt"
SYNC_SCRIPT = TOOLS_DIR / "sync_shopify.py"
DEPLOY_SCRIPT = REPO_DIR / "deploy.py"
RELEASE_FILE = REPO_DIR / "shop_notice_release.js"

SHOPIFY_DOMAIN = "vh55x1-pa.myshopify.com"
SHOPIFY_ADMIN_API_VERSION = "2026-01"
MAX_TARGETS = 200

# --- Shopify公開前ロック（Phase F-04-F01 緊急安全修正） ---
# コード上で固定した真偽値であり、環境変数・.env・CLI引数のいずれからも読み取らない。
# これらのいずれかで解除できる実装、および隠しオプション・テスト用バイパスは意図的に作らない。
# 解除は、店主承認後の別PRでこの定数そのものを変更することでのみ行う。
PRELAUNCH_LOCKED = True
PRELAUNCH_LOCK_REASON_CODE = "SHOPIFY_REGISTRATION_PRELAUNCH_LOCKED"
PRELAUNCH_LOCK_MESSAGE = "Shopify登録は正式公開前のため停止中です。商品・在庫は変更されていません。"


class DropError(Exception):
    pass


def enforce_prelaunch_lock():
    """main()の最初の文として呼び出す。Shopify query/mutation・sync/deployより前に、
    無条件で非0終了する。token・入力・パス等は出力しない。"""
    if PRELAUNCH_LOCKED:
        print(PRELAUNCH_LOCK_MESSAGE, file=sys.stderr)
        print(PRELAUNCH_LOCK_REASON_CODE, file=sys.stderr)
        sys.exit(1)


def read_admin_token():
    if not ENV_PATH.exists():
        raise DropError(f".env が見つかりません: {ENV_PATH}")
    with open(ENV_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line.startswith("SHOPIFY_ADMIN_TOKEN="):
                token = line.split("=", 1)[1].strip()
                if token:
                    return token
    raise DropError("SHOPIFY_ADMIN_TOKEN が .env に見つかりません")


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
        raise DropError(f"Shopify Admin API通信エラー: {e}")
    if "errors" in data:
        raise DropError(f"Shopify Admin APIエラー: {data['errors']}")
    return data["data"]


PUBLICATIONS_QUERY = "query { publications(first: 25) { edges { node { id name } } } }"


def resolve_publications(token):
    data = admin_graphql(token, PUBLICATIONS_QUERY)
    pubs = [e["node"] for e in data["publications"]["edges"]]
    online_store = next((p for p in pubs if "online store" in p["name"].lower() or "オンラインストア" in p["name"]), None)
    headless = next((p for p in pubs if "headless" in p["name"].lower()), None)
    if online_store is None or headless is None:
        listing = "\n".join(f"  - {p['name']} ({p['id']})" for p in pubs)
        raise DropError(f"Online Store / Headless チャネルのpublicationを特定できません。見つかった一覧:\n{listing}")
    return online_store, headless


# ponytail: Shopifyのproducts(query:"tag:...")検索はCJKタグの厳密一致を保証しない
# （トークナイズの都合で部分一致/不一致になり得る）ため、全商品を取得して
# タグ一致はこちら側で文字列比較のみで判定する。3,139件でも250件/頁で軽い。
PRODUCTS_PAGE_QUERY = """
query($cursor: String, $onlineId: ID!, $headlessId: ID!) {
  products(first: 250, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        title
        vendor
        status
        tags
        totalInventory
        publishedOnline: publishedOnPublication(publicationId: $onlineId)
        publishedHeadless: publishedOnPublication(publicationId: $headlessId)
      }
    }
  }
}
"""


def fetch_all_products(token, online_id, headless_id):
    products = []
    cursor = None
    while True:
        data = admin_graphql(token, PRODUCTS_PAGE_QUERY, {
            "cursor": cursor, "onlineId": online_id, "headlessId": headless_id,
        })
        page = data["products"]
        products.extend(e["node"] for e in page["edges"])
        if not page["pageInfo"]["hasNextPage"]:
            break
        cursor = page["pageInfo"]["endCursor"]
    return products


def exact_tag_match(node, exhibition):
    return any(t.strip() == exhibition for t in node["tags"])


def classify(products, exhibition):
    targets = []
    excluded = {"not_active": [], "out_of_stock": [], "already_published": []}
    for p in products:
        if not exact_tag_match(p, exhibition):
            continue
        if p["status"] != "ACTIVE":
            excluded["not_active"].append(p)
        elif p["totalInventory"] <= 0:
            excluded["out_of_stock"].append(p)
        elif p["publishedOnline"] and p["publishedHeadless"]:
            excluded["already_published"].append(p)
        else:
            targets.append(p)
    return targets, excluded


PUBLISH_MUTATION = """
mutation($id: ID!, $input: [PublicationInput!]!) {
  publishablePublish(id: $id, input: $input) {
    userErrors { field message }
  }
}
"""


def publish_product(token, product, online_id, headless_id):
    data = admin_graphql(token, PUBLISH_MUTATION, {
        "id": product["id"],
        "input": [{"publicationId": online_id}, {"publicationId": headless_id}],
    })
    errors = data["publishablePublish"]["userErrors"]
    return errors


def label(p):
    return f"{p['title']} ({p['id']})"


def append_log(lines):
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n\n")


def update_release_id():
    """注意事項モーダルの公開IDを現在UTC日時へ更新する。書き込み失敗時は例外を送出する
    （呼び出し側はこの場合デプロイを行わないこと）。"""
    new_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    content = (
        "/* ARC FUKAMEKI — オンラインショップ注意事項の「公開ID」\n"
        "   この値が変わると、確認済みの利用者にも注意事項モーダルを再表示する。\n"
        "   本文だけを改訂した場合も、この値を新しいUTC日時へ変更してデプロイすること。\n"
        "   tools/drop_release.py の本実行（公開成功1件以上）でも自動更新される。 */\n"
        f"window.SHOP_NOTICE_RELEASE_ID = '{new_id}';\n"
    )
    RELEASE_FILE.write_text(content, encoding="utf-8")
    return new_id


def main():
    enforce_prelaunch_lock()
    parser = argparse.ArgumentParser()
    parser.add_argument("--exhibition", required=True, help="企画展名（タグと厳密一致・前後空白trimのみ）")
    parser.add_argument("--dry-run", action="store_true", help="対象一覧の表示のみ。公開・同期なし")
    parser.add_argument("--no-sync", action="store_true", help="公開後の sync_shopify.py 実行をスキップ")
    args = parser.parse_args()
    exhibition = args.exhibition.strip()
    now = datetime.now(timezone.utc).isoformat()

    try:
        token = read_admin_token()
        online_pub, headless_pub = resolve_publications(token)
        all_products = fetch_all_products(token, online_pub["id"], headless_pub["id"])
    except DropError as e:
        append_log([f"[{now}] エラー（企画展: {exhibition}）: {e}"])
        print(f"エラー: {e}", file=sys.stderr)
        sys.exit(1)

    targets, excluded = classify(all_products, exhibition)

    if args.dry_run:
        print(f"企画展: {exhibition}")
        print(f"公開対象: {len(targets)}件")
        for p in targets:
            print(f"  - {label(p)}")
        print(f"在庫0で除外: {len(excluded['out_of_stock'])}件")
        for p in excluded["out_of_stock"]:
            print(f"  - {label(p)}")
        print(f"既に公開済みで除外: {len(excluded['already_published'])}件")
        for p in excluded["already_published"]:
            print(f"  - {label(p)}")
        if excluded["not_active"]:
            print(f"非ACTIVEで除外: {len(excluded['not_active'])}件")
            for p in excluded["not_active"]:
                print(f"  - {label(p)}")
        if not targets and not any(excluded.values()):
            print("\nタグ一致なし。対象なし。")
        print("\n--dry-run のため公開・同期は行っていません。")
        return

    if not targets:
        append_log([f"[{now}] 企画展: {exhibition} — 対象なし（正常終了）"])
        print("対象なし。正常終了します。")
        return

    if len(targets) > MAX_TARGETS:
        head = "\n".join(f"  - {label(p)}" for p in targets[:20])
        append_log([
            f"[{now}] エラー（企画展: {exhibition}）: 対象{len(targets)}件が上限{MAX_TARGETS}件を超過。中止しました。",
            f"先頭20件:\n{head}",
        ])
        print(f"エラー: 対象{len(targets)}件が上限{MAX_TARGETS}件を超過。タグ誤指定の可能性があるため中止します。", file=sys.stderr)
        sys.exit(1)

    published, errors = [], []
    for p in targets:
        errs = publish_product(token, p, online_pub["id"], headless_pub["id"])
        if errs:
            errors.append((p, errs))
        else:
            published.append(p)

    print(f"公開成功: {len(published)}件 / エラー: {len(errors)}件")
    for p in published:
        print(f"  - {label(p)}")
    for p, errs in errors:
        print(f"  ERR {label(p)}: {errs}", file=sys.stderr)

    # 処理順序（事故防止のため厳守）:
    # 1. Shopifyで対象商品を公開（済み・上記published/errors）
    # 2. 公開成功が1件以上あることを確認（0件ならsync_shopify.py自体を呼ばず正常終了）
    # 3. sync_shopify.py --no-deploy を正常完了させる
    # 4. shop_notice_release.js を更新（公開ID）
    # 5. deploy.py を1回だけ実行
    # 同期・公開ID書き込み・デプロイのいずれかに失敗したら、最終的に終了コード1にする
    # （在庫管理画面のジョブ監視が done ではなく error と認識できるようにするため）。
    # ログ欠落を避けるため、失敗はここでは即終了せず変数に保持し、append_log() の後に sys.exit(1) する。
    sync_ran = False
    sync_ok = False
    release_id = None
    release_updated = False
    deploy_ran = False
    deploy_error = ""
    release_write_error = ""
    had_failure = False

    if not args.no_sync and len(published) >= 1:
        try:
            subprocess.run([sys.executable, str(SYNC_SCRIPT), "--no-deploy"], cwd=str(REPO_DIR), check=True)
            sync_ran = True
            sync_ok = True
        except subprocess.CalledProcessError as e:
            print(f"sync_shopify.py 実行エラー: {e}", file=sys.stderr)
            sync_ran = True
            sync_ok = False
            had_failure = True

        if sync_ok:
            try:
                release_id = update_release_id()
                release_updated = True
            except OSError as e:
                release_write_error = str(e)
                print(f"公開ID更新エラー（shop_notice_release.js 書き込み失敗）: {e}", file=sys.stderr)
                had_failure = True

            if release_updated:
                try:
                    subprocess.run([sys.executable, str(DEPLOY_SCRIPT)], cwd=str(REPO_DIR), check=True)
                    deploy_ran = True
                except subprocess.CalledProcessError as e:
                    deploy_error = str(e)
                    print(
                        f"エラー: Shopify公開は成功していますが、deploy.py実行に失敗しHPへの反映ができていません: {e}",
                        file=sys.stderr,
                    )
                    had_failure = True

    def join_labels(items):
        return "、".join(label(p) for p in items) or "なし"

    append_log([
        f"[{now}] 企画展: {exhibition}",
        f"公開{len(published)}件: {join_labels(published)}",
        f"在庫0スキップ{len(excluded['out_of_stock'])}件: {join_labels(excluded['out_of_stock'])}",
        f"既公開スキップ{len(excluded['already_published'])}件: {join_labels(excluded['already_published'])}",
        f"非ACTIVEスキップ{len(excluded['not_active'])}件: {join_labels(excluded['not_active'])}",
        f"エラー{len(errors)}件: " + ("、".join(f'{label(p)}: {e}' for p, e in errors) or "なし"),
        f"HP同期実行: {'はい' if sync_ran else 'いいえ（--no-syncまたは公開成功0件）'} / 同期成功: {'はい' if sync_ok else 'いいえ' if sync_ran else 'N/A'}",
        f"公開ID更新: {'はい (' + release_id + ')' if release_updated else 'いいえ' + (' — 書込エラー: ' + release_write_error if release_write_error else '')}",
        f"デプロイ実行: {'はい' if deploy_ran else ('エラー: ' + deploy_error if deploy_error else 'いいえ')}",
    ])

    if had_failure:
        sys.exit(1)

    if deploy_error:
        sys.exit(1)


if __name__ == "__main__":
    main()
