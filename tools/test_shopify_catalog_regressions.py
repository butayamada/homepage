#!/usr/bin/env python3
"""
Shopify UNLISTEDカタログ生成の回帰検証（PR #5 独立監査FAIL対応）。

実Shopify通信は行わない（build_catalog_entries / sanitize_description /
visible_text_is_empty はネットワークに依存しない純粋関数のため、そのまま単体テストする）。
一時ファイルはリポジトリへ残さず、実行後に自動削除する。

Usage:
    python tools/test_shopify_catalog_regressions.py
"""
import hashlib
import importlib.util
import sys
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
REPO_DIR = TOOLS_DIR.parent
CATALOG_PATH = REPO_DIR / "products_catalog.generated.js"

spec = importlib.util.spec_from_file_location("build_shopify_catalog", TOOLS_DIR / "build_shopify_catalog.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

results = []


def check(name, condition):
    results.append((name, bool(condition)))
    print(("PASS" if condition else "FAIL") + f": {name}")


def make_product(gid, title="テスト商品", description="<p>通常の説明文です。</p>", headless=True,
                  variant_gid=None, images=None, product_type="Ceramics", vendor="ARC FUKAMEKI minoh"):
    variant_gid = variant_gid or (gid.replace("/Product/", "/ProductVariant/") + "1")
    images = images if images is not None else ["https://cdn.shopify.com/example.jpg"]
    return {
        "id": gid,
        "title": title,
        "status": "UNLISTED",
        "vendor": vendor,
        "productType": product_type,
        "descriptionHtml": description,
        "updatedAt": "2026-08-06T00:00:00Z",
        "images": {"edges": [{"node": {"url": u, "altText": None}} for u in images]},
        "variants": {"edges": [{"node": {
            "id": variant_gid, "title": "Default Title", "availableForSale": True,
            "selectedOptions": [{"name": "Title", "value": "Default Title"}], "price": "1000",
        }}]},
        "headlessPublished": headless,
    }


# ---------- name/shopifyTitle 完全一致（既存alias上書きなし） ----------
p1 = make_product("gid://shopify/Product/1")
entries = mod.build_catalog_entries([p1], variant_to_hp_id={p1["variants"]["edges"][0]["node"]["id"]: "existing_hp_id_999"})
check("既存aliasがあってもnameはShopifyタイトルのまま", entries[0]["name"] == p1["title"] and entries[0]["shopifyTitle"] == p1["title"])
check("既存aliasはcatalogIdに反映される（URL互換維持）", entries[0]["catalogId"] == "existing_hp_id_999")
check("existingAliasはURL用途のみでtitleに影響しない", entries[0]["existingAlias"] == "existing_hp_id_999")

# ---------- Headless未公開1件で生成失敗 ----------
p_headless_false = make_product("gid://shopify/Product/2", headless=False)
try:
    mod.build_catalog_entries([p_headless_false], variant_to_hp_id={})
    check("Headless未公開1件で例外送出", False)
except mod.CatalogError as e:
    check("Headless未公開1件で例外送出", "Headless未公開" in str(e) and "gid://shopify/Product/2" in str(e))

# ---------- publication 0件・複数候補で例外 ----------
class FakeAdminGraphqlZero:
    def __call__(self, token, query, variables=None):
        return {"publications": {"edges": []}}


class FakeAdminGraphqlMulti:
    def __call__(self, token, query, variables=None):
        return {"publications": {"edges": [
            {"node": {"id": "gid://shopify/Publication/1", "name": "Headless A"}},
            {"node": {"id": "gid://shopify/Publication/2", "name": "Headless B"}},
        ]}}


orig_admin_graphql = mod.admin_graphql
try:
    mod.admin_graphql = FakeAdminGraphqlZero()
    try:
        mod.resolve_headless_publication("dummy-token")
        check("publication 0件で例外送出", False)
    except mod.CatalogError:
        check("publication 0件で例外送出", True)

    mod.admin_graphql = FakeAdminGraphqlMulti()
    try:
        mod.resolve_headless_publication("dummy-token")
        check("publication 複数候補で例外送出", False)
    except mod.CatalogError:
        check("publication 複数候補で例外送出", True)
finally:
    mod.admin_graphql = orig_admin_graphql

# ---------- 空説明の判定 ----------
empty_cases = {
    "null相当(空文字)": "",
    "空白だけ": "   \n\t  ",
    "空タグだけ": "<p></p><br>",
    "可視文字なしのネスト": "<p><span></span></p>",
    "scriptだけ": "<script>alert(1)</script>",
    "コメントだけ": "<!-- comment only -->",
    "style除去対象だけ": "<style>.x{color:red}</style>",
}
for label, html in empty_cases.items():
    sanitized = mod.sanitize_description(html)
    check(f"空説明として検出: {label}", mod.visible_text_is_empty(sanitized))

nonempty_cases = {
    "通常の文章": "<p>これは通常の説明文です。</p>",
    "許可タグ混在": "<p>説明<strong>強調</strong>あり</p><ul><li>項目</li></ul>",
    "scriptに紛れた本文": "<script>bad()</script><p>本文はここ</p>",
}
for label, html in nonempty_cases.items():
    sanitized = mod.sanitize_description(html)
    check(f"非空説明として通過: {label}", not mod.visible_text_is_empty(sanitized))

check("scriptタグの中身は可視テキストへ混入しない",
      "bad()" not in mod.sanitize_description("<script>bad()</script><p>本文</p>"))

# ---------- 空説明の商品はbuild_catalog_entriesで生成失敗 ----------
p_empty_desc = make_product("gid://shopify/Product/3", description="<p></p>")
try:
    mod.build_catalog_entries([p_empty_desc], variant_to_hp_id={})
    check("空説明商品で例外送出", False)
except mod.CatalogError as e:
    check("空説明商品で例外送出", "商品説明が空" in str(e) and "gid://shopify/Product/3" in str(e))

# ---------- 失敗時に既存生成物・一時ファイルへ影響しないこと ----------
if CATALOG_PATH.exists():
    before_hash = hashlib.sha256(CATALOG_PATH.read_bytes()).hexdigest()
    try:
        mod.build_catalog_entries([p_headless_false], variant_to_hp_id={})
    except mod.CatalogError:
        pass
    after_hash = hashlib.sha256(CATALOG_PATH.read_bytes()).hexdigest()
    check("失敗しても既存生成物のSHA-256が不変", before_hash == after_hash)
    tmp_path = CATALOG_PATH.with_suffix(CATALOG_PATH.suffix + ".tmp")
    check("一時ファイルが残っていない", not tmp_path.exists())
else:
    print("SKIP: products_catalog.generated.js が存在しないためハッシュ不変テストを省略")


print("\n=== SUMMARY ===")
failed = [name for name, ok in results if not ok]
print(f"{len(results) - len(failed)}/{len(results)} PASS")
if failed:
    print("FAILED:")
    for name in failed:
        print(f"  - {name}")
    sys.exit(1)
sys.exit(0)
