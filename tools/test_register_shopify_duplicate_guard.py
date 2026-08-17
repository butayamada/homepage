"""
Phase F-01: 完全一致重複のハードストップ化 テスト。
実Shopify APIには一切接続せず、admin_graphql をモックして完結させる。
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest import mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import register_shopify as rs


EXHIBITION = "テスト企画展"


def make_item(id_, name, supplier="作家A", stock=1, inspected=True):
    return {
        "id": id_,
        "exhibition": EXHIBITION,
        "supplier": supplier,
        "name": name,
        "inspected": inspected,
        "stock": stock,
        "retail": 1000,
        "taxRate": 10,
        "size": {},
        "note": "",
        "photoIds": [],
    }


@pytest.fixture(autouse=True)
def isolated_paths(tmp_path, monkeypatch):
    """ledger/log を一時ディレクトリへ差し替え、.env はダミートークンで用意する。"""
    ledger_path = tmp_path / "shopify_register_ledger.json"
    log_path = tmp_path / "register_shopify_log.txt"
    monkeypatch.setattr(rs, "LEDGER_PATH", ledger_path)
    monkeypatch.setattr(rs, "LOG_PATH", log_path)
    monkeypatch.setattr(rs, "read_admin_token", lambda: "dummy-test-token")
    yield tmp_path


def write_inventory(tmp_path, items):
    path = tmp_path / "inventory.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False)
    return path


def run_main(argv, monkeypatch):
    monkeypatch.setattr(sys, "argv", ["register_shopify.py"] + argv)
    try:
        rs.main()
        return 0
    except SystemExit as e:
        return e.code or 0


# ---------------------------------------------------------------------------
# 1. 完全一致1件 → dry-run 非0終了、mutation 0、ledger変更0
# ---------------------------------------------------------------------------
def test_exact_duplicate_dry_run_hard_stops(isolated_paths, monkeypatch):
    tmp_path = isolated_paths
    items = [make_item(101, "湯呑み")]
    inv_path = write_inventory(tmp_path, items)

    monkeypatch.setattr(rs, "fetch_all_titles", lambda token: {rs.normalize_title("作家A　湯呑み")})
    graphql_calls = []
    monkeypatch.setattr(rs, "admin_graphql", lambda *a, **k: graphql_calls.append(a) or {})

    code = run_main(["--exhibition", EXHIBITION, "--dry-run", "--source", str(inv_path)], monkeypatch)

    assert code != 0
    assert graphql_calls == []
    assert not rs.LEDGER_PATH.exists()


# ---------------------------------------------------------------------------
# 2. NFKC差異 → 重複として停止
# ---------------------------------------------------------------------------
def test_nfkc_difference_is_duplicate(isolated_paths, monkeypatch):
    tmp_path = isolated_paths
    # 全角英数 vs 半角英数（NFKCで一致する）
    items = [make_item(102, "ＡＢＣマグ")]
    inv_path = write_inventory(tmp_path, items)

    monkeypatch.setattr(rs, "fetch_all_titles", lambda token: {rs.normalize_title("作家A　ABCマグ")})
    monkeypatch.setattr(rs, "admin_graphql", lambda *a, **k: pytest.fail("mutation must not be called"))

    code = run_main(["--exhibition", EXHIBITION, "--dry-run", "--source", str(inv_path)], monkeypatch)
    assert code != 0


# ---------------------------------------------------------------------------
# 3. 半角・全角空白差異 → 重複として停止
# ---------------------------------------------------------------------------
def test_whitespace_difference_is_duplicate(isolated_paths, monkeypatch):
    tmp_path = isolated_paths
    items = [make_item(103, "皿  大")]  # 半角空白2つ
    inv_path = write_inventory(tmp_path, items)

    # 既存側は全角空白＋通常結合（正規化で両方とも空白除去され一致する）
    existing_title = rs.normalize_title("作家A　皿　大")
    monkeypatch.setattr(rs, "fetch_all_titles", lambda token: {existing_title})
    monkeypatch.setattr(rs, "admin_graphql", lambda *a, **k: pytest.fail("mutation must not be called"))

    code = run_main(["--exhibition", EXHIBITION, "--dry-run", "--source", str(inv_path)], monkeypatch)
    assert code != 0


# ---------------------------------------------------------------------------
# 4. 複数対象のうち1件だけ重複 → バッチ全体停止、登録0件
# ---------------------------------------------------------------------------
def test_one_of_many_duplicate_stops_whole_batch(isolated_paths, monkeypatch):
    tmp_path = isolated_paths
    items = [make_item(201, "花瓶A"), make_item(202, "花瓶B"), make_item(203, "花瓶C")]
    inv_path = write_inventory(tmp_path, items)

    monkeypatch.setattr(rs, "fetch_all_titles", lambda token: {rs.normalize_title("作家A　花瓶B")})
    calls = []
    monkeypatch.setattr(rs, "admin_graphql", lambda *a, **k: calls.append(a) or {})
    monkeypatch.setattr(rs, "get_location_id", lambda token: pytest.fail("get_location_id must not be called"))
    monkeypatch.setattr(rs, "register_one", lambda *a, **k: pytest.fail("register_one must not be called"))

    code = run_main(["--exhibition", EXHIBITION, "--source", str(inv_path)], monkeypatch)

    assert code != 0
    assert calls == []
    assert not rs.LEDGER_PATH.exists()


# ---------------------------------------------------------------------------
# 5. 複数重複 → 全件表示、登録0件
# ---------------------------------------------------------------------------
def test_multiple_duplicates_all_listed(isolated_paths, monkeypatch, capsys):
    tmp_path = isolated_paths
    items = [make_item(301, "碗A"), make_item(302, "碗B")]
    inv_path = write_inventory(tmp_path, items)

    monkeypatch.setattr(rs, "fetch_all_titles", lambda token: {
        rs.normalize_title("作家A　碗A"), rs.normalize_title("作家A　碗B"),
    })
    monkeypatch.setattr(rs, "register_one", lambda *a, **k: pytest.fail("register_one must not be called"))

    code = run_main(["--exhibition", EXHIBITION, "--dry-run", "--source", str(inv_path)], monkeypatch)
    out = capsys.readouterr().out

    assert code != 0
    assert "碗A" in out and "碗B" in out
    assert not rs.LEDGER_PATH.exists()


# ---------------------------------------------------------------------------
# 6. 重複なしdry-run → 正常終了、mutation 0
# ---------------------------------------------------------------------------
def test_no_duplicate_dry_run_succeeds(isolated_paths, monkeypatch):
    tmp_path = isolated_paths
    items = [make_item(401, "箸置き")]
    inv_path = write_inventory(tmp_path, items)

    monkeypatch.setattr(rs, "fetch_all_titles", lambda token: set())
    calls = []
    monkeypatch.setattr(rs, "admin_graphql", lambda *a, **k: calls.append(a) or {})

    code = run_main(["--exhibition", EXHIBITION, "--dry-run", "--source", str(inv_path)], monkeypatch)

    assert code == 0
    assert calls == []


# ---------------------------------------------------------------------------
# 7. 通常実行で重複 → mutation開始前に停止
# ---------------------------------------------------------------------------
def test_normal_run_duplicate_stops_before_mutation(isolated_paths, monkeypatch):
    tmp_path = isolated_paths
    items = [make_item(501, "灯り")]
    inv_path = write_inventory(tmp_path, items)

    monkeypatch.setattr(rs, "fetch_all_titles", lambda token: {rs.normalize_title("作家A　灯り")})
    monkeypatch.setattr(rs, "get_location_id", lambda token: pytest.fail("get_location_id must not be called"))
    monkeypatch.setattr(rs, "register_one", lambda *a, **k: pytest.fail("register_one must not be called"))

    code = run_main(["--exhibition", EXHIBITION, "--source", str(inv_path)], monkeypatch)

    assert code != 0
    assert not rs.LEDGER_PATH.exists()


# ---------------------------------------------------------------------------
# 8. Shopify一覧取得失敗 → fail-closed
# ---------------------------------------------------------------------------
def test_fetch_titles_failure_fails_closed(isolated_paths, monkeypatch):
    tmp_path = isolated_paths
    items = [make_item(601, "何か")]
    inv_path = write_inventory(tmp_path, items)

    def boom(token):
        raise rs.RegisterError("通信エラー")
    monkeypatch.setattr(rs, "fetch_all_titles", boom)
    monkeypatch.setattr(rs, "register_one", lambda *a, **k: pytest.fail("register_one must not be called"))

    code = run_main(["--exhibition", EXHIBITION, "--source", str(inv_path)], monkeypatch)
    assert code != 0


# ---------------------------------------------------------------------------
# 9. GraphQL errors → fail-closed
# ---------------------------------------------------------------------------
def test_graphql_errors_field_fails_closed():
    fake_urlopen_response = json.dumps({"errors": [{"message": "boom"}]}).encode("utf-8")

    class FakeResp:
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def read(self):
            return fake_urlopen_response

    with mock.patch.object(rs.urllib.request, "urlopen", return_value=FakeResp()):
        with pytest.raises(rs.RegisterError):
            rs.admin_graphql("dummy-token", "query {}")


# ---------------------------------------------------------------------------
# 10. タイトルnull・欠落・配列・数値 → fail-closed
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("bad_title", [None, 12345, ["not", "a", "string"], {}])
def test_non_string_existing_title_fails_closed(bad_title, monkeypatch):
    calls = {"n": 0}

    def fake_admin_graphql(token, query, variables=None):
        calls["n"] += 1
        return {
            "products": {
                "pageInfo": {"hasNextPage": False, "endCursor": None},
                "edges": [{"node": {"title": bad_title}}],
            }
        }

    monkeypatch.setattr(rs, "admin_graphql", fake_admin_graphql)
    with pytest.raises(rs.RegisterError):
        rs.fetch_all_titles("dummy-token")


def test_missing_title_field_fails_closed(monkeypatch):
    def fake_admin_graphql(token, query, variables=None):
        return {
            "products": {
                "pageInfo": {"hasNextPage": False, "endCursor": None},
                "edges": [{"node": {}}],
            }
        }

    monkeypatch.setattr(rs, "admin_graphql", fake_admin_graphql)
    with pytest.raises(rs.RegisterError):
        rs.fetch_all_titles("dummy-token")


def test_malformed_products_structure_fails_closed(monkeypatch):
    monkeypatch.setattr(rs, "admin_graphql", lambda *a, **k: {"products": {"unexpected": True}})
    with pytest.raises(rs.RegisterError):
        rs.fetch_all_titles("dummy-token")


def test_find_duplicates_bad_existing_titles_type_fails_closed():
    with pytest.raises(rs.RegisterError):
        rs.find_duplicates([make_item(1, "x")], ["not", "a", "set"])


# ---------------------------------------------------------------------------
# 11. ledgerが既に登録済みとするinventory ID → 従来どおり対象外、回帰なし
# ---------------------------------------------------------------------------
def test_already_registered_ledger_excludes_item(isolated_paths, monkeypatch):
    tmp_path = isolated_paths
    items = [make_item(701, "杯")]
    inv_path = write_inventory(tmp_path, items)
    ledger_path = tmp_path / "shopify_register_ledger.json"
    with open(ledger_path, "w", encoding="utf-8") as f:
        json.dump({"701": {"gid": "gid://shopify/Product/1", "title": "作家A　杯", "registeredAt": "x"}}, f)
    monkeypatch.setattr(rs, "LEDGER_PATH", ledger_path)

    monkeypatch.setattr(rs, "fetch_all_titles", lambda token: set())
    monkeypatch.setattr(rs, "register_one", lambda *a, **k: pytest.fail("register_one must not be called"))

    code = run_main(["--exhibition", EXHIBITION, "--dry-run", "--source", str(inv_path)], monkeypatch)
    assert code == 0


# ---------------------------------------------------------------------------
# 12. 「登録は続行します」がコード・出力に0件
# ---------------------------------------------------------------------------
def test_old_continue_message_absent_from_source():
    src = Path(rs.__file__).read_text(encoding="utf-8")
    assert "続行します" not in src


def test_old_continue_message_absent_from_output(isolated_paths, monkeypatch, capsys):
    tmp_path = isolated_paths
    items = [make_item(801, "小鉢")]
    inv_path = write_inventory(tmp_path, items)
    monkeypatch.setattr(rs, "fetch_all_titles", lambda token: {rs.normalize_title("作家A　小鉢")})

    run_main(["--exhibition", EXHIBITION, "--dry-run", "--source", str(inv_path)], monkeypatch)
    out = capsys.readouterr().out
    assert "続行します" not in out


# ---------------------------------------------------------------------------
# 13. token・Cookie・絶対的な秘密値が成果物に0件
# ---------------------------------------------------------------------------
def test_no_secret_leak_in_output_or_log(isolated_paths, monkeypatch, capsys):
    tmp_path = isolated_paths
    items = [make_item(901, "急須")]
    inv_path = write_inventory(tmp_path, items)
    monkeypatch.setattr(rs, "read_admin_token", lambda: "shpat_supersecrettoken123")
    monkeypatch.setattr(rs, "fetch_all_titles", lambda token: {rs.normalize_title("作家A　急須")})

    run_main(["--exhibition", EXHIBITION, "--dry-run", "--source", str(inv_path)], monkeypatch)
    out = capsys.readouterr().out
    assert "shpat_supersecrettoken123" not in out
    if rs.LOG_PATH.exists():
        assert "shpat_supersecrettoken123" not in rs.LOG_PATH.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# 14. 対象上限 MAX_TARGETS の既存停止処理に回帰なし
# ---------------------------------------------------------------------------
def test_max_targets_regression(isolated_paths, monkeypatch):
    tmp_path = isolated_paths
    items = [make_item(1000 + i, f"品{i}") for i in range(rs.MAX_TARGETS + 1)]
    inv_path = write_inventory(tmp_path, items)

    monkeypatch.setattr(rs, "fetch_all_titles", lambda token: set())
    monkeypatch.setattr(rs, "register_one", lambda *a, **k: pytest.fail("register_one must not be called"))

    code = run_main(["--exhibition", EXHIBITION, "--source", str(inv_path)], monkeypatch)
    assert code != 0


# ---------------------------------------------------------------------------
# 15. 正常系の既存dry-run表示に不要な変化なし
# ---------------------------------------------------------------------------
def test_normal_dry_run_output_unchanged_shape(isolated_paths, monkeypatch, capsys):
    tmp_path = isolated_paths
    items = [make_item(1101, "湯冷まし")]
    inv_path = write_inventory(tmp_path, items)
    monkeypatch.setattr(rs, "fetch_all_titles", lambda token: set())

    code = run_main(["--exhibition", EXHIBITION, "--dry-run", "--source", str(inv_path)], monkeypatch)
    out = capsys.readouterr().out

    assert code == 0
    assert f"企画展: {EXHIBITION}" in out
    assert "登録予定: 1件" in out
    assert "湯冷まし" in out
    assert "--dry-run のため登録は行っていません。" in out


# ---------------------------------------------------------------------------
# subprocess-level smoke test: dry-run duplicate exits non-zero for real
# (server.js relies on the process exit code, not just stdout text)
# ---------------------------------------------------------------------------
def test_subprocess_dry_run_duplicate_nonzero_exit(tmp_path, monkeypatch):
    inv_path = write_inventory(tmp_path, [make_item(1201, "急須")])
    env_dir = tmp_path / "env_home"
    env_dir.mkdir()
    (env_dir / ".env").write_text("SHOPIFY_ADMIN_TOKEN=dummy-token\n", encoding="utf-8")

    script = f'''
import sys
sys.path.insert(0, {str(Path(rs.__file__).resolve().parent)!r})
import register_shopify as rs
rs.INVENTORY_DIR = {str(env_dir)!r}
rs.ENV_PATH = rs.INVENTORY_DIR / ".env"
rs.LEDGER_PATH = {str(tmp_path / "ledger.json")!r}
rs.LOG_PATH = {str(tmp_path / "log.txt")!r}
rs.fetch_all_titles = lambda token: {{rs.normalize_title("作家A　急須")}}
sys.argv = ["register_shopify.py", "--exhibition", {EXHIBITION!r}, "--dry-run", "--source", {str(inv_path)!r}]
rs.main()
'''
    result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True)
    assert result.returncode != 0
    assert "続行します" not in result.stdout


# ---------------------------------------------------------------------------
# F-01 Fix Audited Tests: casefold, empty/whitespace, non-string checks
# ---------------------------------------------------------------------------

def test_casefold_duplicates(isolated_paths, monkeypatch):
    tmp_path = isolated_paths

    # 1. ABC and abc
    items = [make_item(2001, "abc")]
    inv_path = write_inventory(tmp_path, items)
    monkeypatch.setattr(rs, "fetch_all_titles", lambda token: {rs.normalize_title("作家A　ABC")})

    graphql_calls = []
    monkeypatch.setattr(rs, "admin_graphql", lambda *a, **k: graphql_calls.append(a) or {})
    monkeypatch.setattr(rs, "get_location_id", lambda token: pytest.fail("get_location_id must not be called"))
    monkeypatch.setattr(rs, "register_one", lambda *a, **k: pytest.fail("register_one must not be called"))

    code = run_main(["--exhibition", EXHIBITION, "--source", str(inv_path)], monkeypatch)
    assert code != 0
    assert graphql_calls == []
    assert not rs.LEDGER_PATH.exists()

def test_nfkc_casefold_duplicates(isolated_paths, monkeypatch):
    tmp_path = isolated_paths

    # 2. Full-width and half-width case difference
    items = [make_item(2002, "ａｂｃ")]
    inv_path = write_inventory(tmp_path, items)
    monkeypatch.setattr(rs, "fetch_all_titles", lambda token: {rs.normalize_title("作家A　ABC")})

    graphql_calls = []
    monkeypatch.setattr(rs, "admin_graphql", lambda *a, **k: graphql_calls.append(a) or {})
    monkeypatch.setattr(rs, "get_location_id", lambda token: pytest.fail("get_location_id must not be called"))
    monkeypatch.setattr(rs, "register_one", lambda *a, **k: pytest.fail("register_one must not be called"))

    code = run_main(["--exhibition", EXHIBITION, "--source", str(inv_path)], monkeypatch)
    assert code != 0
    assert graphql_calls == []
    assert not rs.LEDGER_PATH.exists()

def test_strasse_casefold_duplicates(isolated_paths, monkeypatch):
    tmp_path = isolated_paths

    # 3. Straße and STRASSE
    items = [make_item(2003, "Straße")]
    inv_path = write_inventory(tmp_path, items)
    monkeypatch.setattr(rs, "fetch_all_titles", lambda token: {rs.normalize_title("作家A　STRASSE")})

    graphql_calls = []
    monkeypatch.setattr(rs, "admin_graphql", lambda *a, **k: graphql_calls.append(a) or {})
    monkeypatch.setattr(rs, "get_location_id", lambda token: pytest.fail("get_location_id must not be called"))
    monkeypatch.setattr(rs, "register_one", lambda *a, **k: pytest.fail("register_one must not be called"))

    code = run_main(["--exhibition", EXHIBITION, "--source", str(inv_path)], monkeypatch)
    assert code != 0
    assert graphql_calls == []
    assert not rs.LEDGER_PATH.exists()

def test_case_difference_stops_whole_batch(isolated_paths, monkeypatch):
    tmp_path = isolated_paths

    # 4. A batch with differing case items stops registration before location_id/mutation
    items = [make_item(2004, "item1"), make_item(2005, "item2")]
    inv_path = write_inventory(tmp_path, items)
    monkeypatch.setattr(rs, "fetch_all_titles", lambda token: {rs.normalize_title("作家A　ITEM2")})

    graphql_calls = []
    monkeypatch.setattr(rs, "admin_graphql", lambda *a, **k: graphql_calls.append(a) or {})
    monkeypatch.setattr(rs, "get_location_id", lambda token: pytest.fail("get_location_id must not be called"))
    monkeypatch.setattr(rs, "register_one", lambda *a, **k: pytest.fail("register_one must not be called"))

    code = run_main(["--exhibition", EXHIBITION, "--source", str(inv_path)], monkeypatch)
    assert code != 0
    assert graphql_calls == []
    assert not rs.LEDGER_PATH.exists()

# Empty targets
@pytest.mark.parametrize("empty_name", ["", " ", "　", "\t\n", "\r\n  \t", "\n \t \u3000"])
def test_target_empty_title_fails(isolated_paths, empty_name, monkeypatch):
    tmp_path = isolated_paths
    items = [make_item(3001, empty_name)]
    inv_path = write_inventory(tmp_path, items)

    monkeypatch.setattr(rs, "get_location_id", lambda token: pytest.fail("get_location_id must not be called"))
    monkeypatch.setattr(rs, "register_one", lambda *a, **k: pytest.fail("register_one must not be called"))

    code = run_main(["--exhibition", EXHIBITION, "--source", str(inv_path)], monkeypatch)
    assert code != 0
    assert not rs.LEDGER_PATH.exists()

# Empty Shopify existing
@pytest.mark.parametrize("empty_shopify_title", ["", " ", "　", "\t\n", "\r\n  \t", "\n \t \u3000"])
def test_shopify_empty_title_fails(isolated_paths, empty_shopify_title, monkeypatch):
    tmp_path = isolated_paths
    items = [make_item(3002, "ValidName")]
    inv_path = write_inventory(tmp_path, items)

    def fake_admin_graphql(token, query, variables=None):
        return {
            "products": {
                "pageInfo": {"hasNextPage": False, "endCursor": None},
                "edges": [{"node": {"title": empty_shopify_title}}],
            }
        }
    monkeypatch.setattr(rs, "admin_graphql", fake_admin_graphql)
    monkeypatch.setattr(rs, "get_location_id", lambda token: pytest.fail("get_location_id must not be called"))
    monkeypatch.setattr(rs, "register_one", lambda *a, **k: pytest.fail("register_one must not be called"))

    code = run_main(["--exhibition", EXHIBITION, "--source", str(inv_path)], monkeypatch)
    assert code != 0
    assert not rs.LEDGER_PATH.exists()

# Non-string targets
@pytest.mark.parametrize("bad_value", [None, 123, True, ["abc"], {"a": 1}])
def test_target_non_string_fails(isolated_paths, bad_value, monkeypatch):
    tmp_path = isolated_paths
    items = [make_item(4001, bad_value)]
    inv_path = write_inventory(tmp_path, items)

    monkeypatch.setattr(rs, "get_location_id", lambda token: pytest.fail("get_location_id must not be called"))
    monkeypatch.setattr(rs, "register_one", lambda *a, **k: pytest.fail("register_one must not be called"))

    code = run_main(["--exhibition", EXHIBITION, "--source", str(inv_path)], monkeypatch)
    assert code != 0
    assert not rs.LEDGER_PATH.exists()

# Non-string Shopify existing
@pytest.mark.parametrize("bad_shopify_value", [None, 123, True, ["abc"], {"a": 1}])
def test_shopify_non_string_fails(isolated_paths, bad_shopify_value, monkeypatch):
    tmp_path = isolated_paths
    items = [make_item(4002, "ValidName")]
    inv_path = write_inventory(tmp_path, items)

    def fake_admin_graphql(token, query, variables=None):
        return {
            "products": {
                "pageInfo": {"hasNextPage": False, "endCursor": None},
                "edges": [{"node": {"title": bad_shopify_value}}],
            }
        }
    monkeypatch.setattr(rs, "admin_graphql", fake_admin_graphql)
    monkeypatch.setattr(rs, "get_location_id", lambda token: pytest.fail("get_location_id must not be called"))
    monkeypatch.setattr(rs, "register_one", lambda *a, **k: pytest.fail("register_one must not be called"))

    code = run_main(["--exhibition", EXHIBITION, "--source", str(inv_path)], monkeypatch)
    assert code != 0
    assert not rs.LEDGER_PATH.exists()


# ---------------------------------------------------------------------------
# F-01 Fix Audited Tests Phase 2: hasNextPage and endCursor validation
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("bad_has_next", [None, 0, 1, "", "false", [], {}])
def test_invalid_has_next_page_type_fails(isolated_paths, bad_has_next, monkeypatch):
    tmp_path = isolated_paths
    items = [make_item(5001, "ValidTitle")]
    inv_path = write_inventory(tmp_path, items)

    def fake_admin_graphql(token, query, variables=None):
        return {
            "products": {
                "pageInfo": {"hasNextPage": bad_has_next, "endCursor": "cursor1"},
                "edges": [{"node": {"title": "作家A　別の商品"}}],
            }
        }
    monkeypatch.setattr(rs, "admin_graphql", fake_admin_graphql)
    monkeypatch.setattr(rs, "get_location_id", lambda token: pytest.fail("get_location_id must not be called"))
    monkeypatch.setattr(rs, "register_one", lambda *a, **k: pytest.fail("register_one must not be called"))

    code = run_main(["--exhibition", EXHIBITION, "--source", str(inv_path)], monkeypatch)
    assert code != 0
    assert not rs.LEDGER_PATH.exists()


def test_valid_pagination_normal_flow(isolated_paths, monkeypatch):
    tmp_path = isolated_paths
    items = [make_item(5002, "abc")]
    inv_path = write_inventory(tmp_path, items)

    graphql_calls = []
    def fake_admin_graphql(token, query, variables=None):
        cursor = variables.get("cursor")
        graphql_calls.append(cursor)
        if cursor is None:
            return {
                "products": {
                    "pageInfo": {"hasNextPage": True, "endCursor": "cursor1"},
                    "edges": [{"node": {"title": "作家A　xyz"}}],
                }
            }
        elif cursor == "cursor1":
            return {
                "products": {
                    "pageInfo": {"hasNextPage": True, "endCursor": "cursor2"},
                    "edges": [{"node": {"title": "作家A　ABC"}}],
                }
            }
        elif cursor == "cursor2":
            return {
                "products": {
                    "pageInfo": {"hasNextPage": False, "endCursor": None},
                    "edges": [{"node": {"title": "作家A　other"}}],
                }
            }
        pytest.fail("Unexpected query cursor")

    monkeypatch.setattr(rs, "admin_graphql", fake_admin_graphql)
    monkeypatch.setattr(rs, "get_location_id", lambda token: pytest.fail("get_location_id must not be called"))
    monkeypatch.setattr(rs, "register_one", lambda *a, **k: pytest.fail("register_one must not be called"))

    code = run_main(["--exhibition", EXHIBITION, "--source", str(inv_path)], monkeypatch)
    assert code != 0
    assert graphql_calls == [None, "cursor1", "cursor2"]
    assert not rs.LEDGER_PATH.exists()


@pytest.mark.parametrize("bad_cursor", [
    "MISSING",
    None,
    12345,
    "",
    "   ",
])
def test_invalid_end_cursor_fails(isolated_paths, bad_cursor, monkeypatch):
    tmp_path = isolated_paths
    items = [make_item(5003, "ValidName")]
    inv_path = write_inventory(tmp_path, items)

    def fake_admin_graphql(token, query, variables=None):
        page_info = {"hasNextPage": True}
        if bad_cursor != "MISSING":
            page_info["endCursor"] = bad_cursor
        return {
            "products": {
                "pageInfo": page_info,
                "edges": [{"node": {"title": "作家A　別の商品"}}],
            }
        }
    monkeypatch.setattr(rs, "admin_graphql", fake_admin_graphql)
    monkeypatch.setattr(rs, "get_location_id", lambda token: pytest.fail("get_location_id must not be called"))
    monkeypatch.setattr(rs, "register_one", lambda *a, **k: pytest.fail("register_one must not be called"))

    code = run_main(["--exhibition", EXHIBITION, "--source", str(inv_path)], monkeypatch)
    assert code != 0
    assert not rs.LEDGER_PATH.exists()


def test_repeated_end_cursor_fails(isolated_paths, monkeypatch):
    tmp_path = isolated_paths
    items = [make_item(5004, "ValidName")]
    inv_path = write_inventory(tmp_path, items)

    def fake_admin_graphql(token, query, variables=None):
        return {
            "products": {
                "pageInfo": {"hasNextPage": True, "endCursor": "cursor1"},
                "edges": [{"node": {"title": "作家A　別の商品"}}],
            }
        }
    monkeypatch.setattr(rs, "admin_graphql", fake_admin_graphql)
    monkeypatch.setattr(rs, "get_location_id", lambda token: pytest.fail("get_location_id must not be called"))
    monkeypatch.setattr(rs, "register_one", lambda *a, **k: pytest.fail("register_one must not be called"))

    code = run_main(["--exhibition", EXHIBITION, "--source", str(inv_path)], monkeypatch)
    assert code != 0
    assert not rs.LEDGER_PATH.exists()


def test_cycle_end_cursor_fails(isolated_paths, monkeypatch):
    tmp_path = isolated_paths
    items = [make_item(5005, "ValidName")]
    inv_path = write_inventory(tmp_path, items)

    def fake_admin_graphql(token, query, variables=None):
        cursor = variables.get("cursor")
        if cursor is None:
            return {
                "products": {
                    "pageInfo": {"hasNextPage": True, "endCursor": "cursorA"},
                    "edges": [{"node": {"title": "作家A　別の商品"}}],
                }
            }
        elif cursor == "cursorA":
            return {
                "products": {
                    "pageInfo": {"hasNextPage": True, "endCursor": "cursorB"},
                    "edges": [{"node": {"title": "作家A　別の商品"}}],
                }
            }
        elif cursor == "cursorB":
            return {
                "products": {
                    "pageInfo": {"hasNextPage": True, "endCursor": "cursorA"},
                    "edges": [{"node": {"title": "作家A　別の商品"}}],
                }
            }
        pytest.fail("Unexpected query cursor")

    monkeypatch.setattr(rs, "admin_graphql", fake_admin_graphql)
    monkeypatch.setattr(rs, "get_location_id", lambda token: pytest.fail("get_location_id must not be called"))
    monkeypatch.setattr(rs, "register_one", lambda *a, **k: pytest.fail("register_one must not be called"))

    code = run_main(["--exhibition", EXHIBITION, "--source", str(inv_path)], monkeypatch)
    assert code != 0
    assert not rs.LEDGER_PATH.exists()


@pytest.mark.parametrize("malformed_resp", [
    {"products": "not-a-dict"},
    {"products": {"pageInfo": "not-a-dict", "edges": []}},
    {"products": {"pageInfo": {"hasNextPage": False}, "edges": "not-a-list"}},
    {"products": {"pageInfo": {"hasNextPage": False}, "edges": ["not-a-dict"]}},
    {"products": {"pageInfo": {"hasNextPage": False}, "edges": [{"node": "not-a-dict"}]}},
])
def test_malformed_page_structure_fails(isolated_paths, malformed_resp, monkeypatch):
    tmp_path = isolated_paths
    items = [make_item(5006, "ValidName")]
    inv_path = write_inventory(tmp_path, items)

    monkeypatch.setattr(rs, "admin_graphql", lambda *a, **k: malformed_resp)
    monkeypatch.setattr(rs, "get_location_id", lambda token: pytest.fail("get_location_id must not be called"))
    monkeypatch.setattr(rs, "register_one", lambda *a, **k: pytest.fail("register_one must not be called"))

    code = run_main(["--exhibition", EXHIBITION, "--source", str(inv_path)], monkeypatch)
    assert code != 0
    assert not rs.LEDGER_PATH.exists()

# ---------------------------------------------------------------------------
# F-01A: Pagination Bounds & Cursor Redaction Tests
# ---------------------------------------------------------------------------

def test_page_limit_under_limit_terminates_normally(isolated_paths, monkeypatch):
    tmp_path = isolated_paths
    items = [make_item(6001, '箸置き')]
    inv_path = write_inventory(tmp_path, items)
    monkeypatch.setattr(rs, 'MAX_TITLE_PAGES', 3)

    calls = []
    def fake_admin_graphql(token, query, variables=None):
        calls.append(variables.get('cursor'))
        if len(calls) == 1:
            return {'products': {'pageInfo': {'hasNextPage': True, 'endCursor': 'c1'}, 'edges': [{'node': {'title': '作家A　品1'}}]}}
        else:
            return {'products': {'pageInfo': {'hasNextPage': False, 'endCursor': None}, 'edges': [{'node': {'title': '作家A　品2'}}]}}

    monkeypatch.setattr(rs, 'admin_graphql', fake_admin_graphql)
    code = run_main(['--exhibition', EXHIBITION, '--dry-run', '--source', str(inv_path)], monkeypatch)
    assert code == 0
    assert len(calls) == 2


def test_page_limit_exact_at_limit_false_terminates_normally(isolated_paths, monkeypatch):
    tmp_path = isolated_paths
    items = [make_item(6002, '箸置き')]
    inv_path = write_inventory(tmp_path, items)
    monkeypatch.setattr(rs, 'MAX_TITLE_PAGES', 2)

    calls = []
    def fake_admin_graphql(token, query, variables=None):
        calls.append(variables.get('cursor'))
        if len(calls) == 1:
            return {'products': {'pageInfo': {'hasNextPage': True, 'endCursor': 'c1'}, 'edges': [{'node': {'title': '作家A　品1'}}]}}
        else:
            return {'products': {'pageInfo': {'hasNextPage': False, 'endCursor': None}, 'edges': [{'node': {'title': '作家A　品2'}}]}}

    monkeypatch.setattr(rs, 'admin_graphql', fake_admin_graphql)
    code = run_main(['--exhibition', EXHIBITION, '--dry-run', '--source', str(inv_path)], monkeypatch)
    assert code == 0
    assert len(calls) == 2


def test_page_limit_exact_at_limit_true_stops_batch(isolated_paths, monkeypatch):
    tmp_path = isolated_paths
    items = [make_item(6003, '箸置き')]
    inv_path = write_inventory(tmp_path, items)
    monkeypatch.setattr(rs, 'MAX_TITLE_PAGES', 2)

    calls = []
    def fake_admin_graphql(token, query, variables=None):
        calls.append(variables.get('cursor'))
        cursor_id = f'c{len(calls)}'
        return {'products': {'pageInfo': {'hasNextPage': True, 'endCursor': cursor_id}, 'edges': [{'node': {'title': f'作家A　品{len(calls)}'}}]}}

    monkeypatch.setattr(rs, 'admin_graphql', fake_admin_graphql)
    monkeypatch.setattr(rs, 'get_location_id', lambda token: pytest.fail('get_location_id must not be called'))
    monkeypatch.setattr(rs, 'register_one', lambda *a, **k: pytest.fail('register_one must not be called'))

    # Dry-run
    code_dry = run_main(['--exhibition', EXHIBITION, '--dry-run', '--source', str(inv_path)], monkeypatch)
    assert code_dry != 0
    assert len(calls) == 2
    assert not rs.LEDGER_PATH.exists()

    # Normal run
    calls.clear()
    code_normal = run_main(['--exhibition', EXHIBITION, '--source', str(inv_path)], monkeypatch)
    assert code_normal != 0
    assert len(calls) == 2
    assert not rs.LEDGER_PATH.exists()


def test_infinite_distinct_cursors_stops_at_limit(isolated_paths, monkeypatch):
    tmp_path = isolated_paths
    items = [make_item(6004, '箸置き')]
    inv_path = write_inventory(tmp_path, items)
    monkeypatch.setattr(rs, 'MAX_TITLE_PAGES', 5)

    calls = []
    def fake_admin_graphql(token, query, variables=None):
        calls.append(variables.get('cursor'))
        return {
            'products': {
                'pageInfo': {'hasNextPage': True, 'endCursor': f'unique_cursor_{len(calls)}'},
                'edges': [{'node': {'title': f'作家A　品{len(calls)}'}}]
            }
        }

    monkeypatch.setattr(rs, 'admin_graphql', fake_admin_graphql)
    monkeypatch.setattr(rs, 'get_location_id', lambda token: pytest.fail('get_location_id must not be called'))
    monkeypatch.setattr(rs, 'register_one', lambda *a, **k: pytest.fail('register_one must not be called'))

    code = run_main(['--exhibition', EXHIBITION, '--source', str(inv_path)], monkeypatch)
    assert code != 0
    assert len(calls) == 5
    assert not rs.LEDGER_PATH.exists()


def test_product_count_under_and_exact_limit(isolated_paths, monkeypatch):
    tmp_path = isolated_paths
    items = [make_item(6005, '箸置き')]
    inv_path = write_inventory(tmp_path, items)
    monkeypatch.setattr(rs, 'MAX_EXISTING_PRODUCT_COUNT', 3)

    def fake_admin_graphql(token, query, variables=None):
        return {
            'products': {
                'pageInfo': {'hasNextPage': False, 'endCursor': None},
                'edges': [
                    {'node': {'title': '作家A　品1'}},
                    {'node': {'title': '作家A　品2'}},
                    {'node': {'title': '作家A　品3'}},
                ]
            }
        }

    monkeypatch.setattr(rs, 'admin_graphql', fake_admin_graphql)
    code = run_main(['--exhibition', EXHIBITION, '--dry-run', '--source', str(inv_path)], monkeypatch)
    assert code == 0


def test_product_count_exceeded_by_one_fails_closed(isolated_paths, monkeypatch):
    tmp_path = isolated_paths
    items = [make_item(6006, '箸置き')]
    inv_path = write_inventory(tmp_path, items)
    monkeypatch.setattr(rs, 'MAX_EXISTING_PRODUCT_COUNT', 3)

    def fake_admin_graphql(token, query, variables=None):
        return {
            'products': {
                'pageInfo': {'hasNextPage': False, 'endCursor': None},
                'edges': [
                    {'node': {'title': '作家A　品1'}},
                    {'node': {'title': '作家A　品2'}},
                    {'node': {'title': '作家A　品3'}},
                    {'node': {'title': '作家A　品4'}},
                ]
            }
        }

    monkeypatch.setattr(rs, 'admin_graphql', fake_admin_graphql)
    monkeypatch.setattr(rs, 'get_location_id', lambda token: pytest.fail('get_location_id must not be called'))
    monkeypatch.setattr(rs, 'register_one', lambda *a, **k: pytest.fail('register_one must not be called'))

    code = run_main(['--exhibition', EXHIBITION, '--source', str(inv_path)], monkeypatch)
    assert code != 0
    assert not rs.LEDGER_PATH.exists()


def test_product_count_counts_raw_nodes_with_duplicate_titles(isolated_paths, monkeypatch):
    tmp_path = isolated_paths
    items = [make_item(6007, '箸置き')]
    inv_path = write_inventory(tmp_path, items)
    monkeypatch.setattr(rs, 'MAX_EXISTING_PRODUCT_COUNT', 2)

    def fake_admin_graphql(token, query, variables=None):
        return {
            'products': {
                'pageInfo': {'hasNextPage': False, 'endCursor': None},
                'edges': [
                    {'node': {'title': '作家A　同名'}},
                    {'node': {'title': '作家A　同名'}},
                    {'node': {'title': '作家A　同名'}},
                ]
            }
        }

    monkeypatch.setattr(rs, 'admin_graphql', fake_admin_graphql)
    monkeypatch.setattr(rs, 'get_location_id', lambda token: pytest.fail('get_location_id must not be called'))
    monkeypatch.setattr(rs, 'register_one', lambda *a, **k: pytest.fail('register_one must not be called'))

    code = run_main(['--exhibition', EXHIBITION, '--source', str(inv_path)], monkeypatch)
    assert code != 0
    assert not rs.LEDGER_PATH.exists()


@pytest.mark.parametrize('scenario', ['same_as_current', 'repeated_seen', 'cycle_a_b_a'])
def test_cursor_value_redaction_in_all_outputs(isolated_paths, scenario, monkeypatch, capsys):
    tmp_path = isolated_paths
    items = [make_item(6008, '箸置き')]
    inv_path = write_inventory(tmp_path, items)

    secret_cursor = 'CURSOR_SHOULD_NEVER_APPEAR_12345'
    secret_cursor_b = 'CURSOR_SHOULD_NEVER_APPEAR_67890'

    def fake_admin_graphql(token, query, variables=None):
        cursor = variables.get('cursor')
        if scenario == 'same_as_current':
            return {'products': {'pageInfo': {'hasNextPage': True, 'endCursor': cursor or secret_cursor}, 'edges': [{'node': {'title': '作家A　品1'}}]}}
        elif scenario == 'repeated_seen':
            return {'products': {'pageInfo': {'hasNextPage': True, 'endCursor': secret_cursor}, 'edges': [{'node': {'title': '作家A　品1'}}]}}
        elif scenario == 'cycle_a_b_a':
            if cursor is None:
                return {'products': {'pageInfo': {'hasNextPage': True, 'endCursor': secret_cursor}, 'edges': [{'node': {'title': '作家A　品1'}}]}}
            elif cursor == secret_cursor:
                return {'products': {'pageInfo': {'hasNextPage': True, 'endCursor': secret_cursor_b}, 'edges': [{'node': {'title': '作家A　品2'}}]}}
            else:
                return {'products': {'pageInfo': {'hasNextPage': True, 'endCursor': secret_cursor}, 'edges': [{'node': {'title': '作家A　品3'}}]}}

    monkeypatch.setattr(rs, 'admin_graphql', fake_admin_graphql)
    monkeypatch.setattr(rs, 'get_location_id', lambda token: pytest.fail('get_location_id must not be called'))
    monkeypatch.setattr(rs, 'register_one', lambda *a, **k: pytest.fail('register_one must not be called'))

    code = run_main(['--exhibition', EXHIBITION, '--source', str(inv_path)], monkeypatch)
    assert code != 0

    captured = capsys.readouterr()
    assert secret_cursor not in captured.out
    assert secret_cursor not in captured.err
    assert secret_cursor_b not in captured.out
    assert secret_cursor_b not in captured.err

    if rs.LOG_PATH.exists():
        log_content = rs.LOG_PATH.read_text(encoding='utf-8')
        assert secret_cursor not in log_content
        assert secret_cursor_b not in log_content

    with pytest.raises(rs.RegisterError) as excinfo:
        rs.fetch_all_titles('dummy-token')
    assert secret_cursor not in str(excinfo.value)
    assert secret_cursor_b not in str(excinfo.value)


# ---------------------------------------------------------------------------
# F-01A: Luna受入阻害事項の是正確認
# 「ページ数・商品件数の上限判定が edge/node/title の完全な構造検証より先に
#  実行され、不正構造が上限エラーに隠される」に対する境界試験16件。
# すべて上限を超過し得る条件下で、実際に返る例外が「上限超過」系メッセージ
# ではなく構造検証系メッセージであることを直接検証する（マスキングの再発防止）。
# ---------------------------------------------------------------------------

BOUND_MESSAGE_FRAGMENTS = ('上限', '次ページを取得できません')


def assert_structural_not_bound(excinfo_value):
    msg = str(excinfo_value)
    for frag in BOUND_MESSAGE_FRAGMENTS:
        assert frag not in msg, f"上限系メッセージに隠された可能性: {msg!r}"


# --- Group A: ページ数がちょうど上限を超過する境界で、構造不正が隠されない ---

def test_page_count_boundary_bad_edge_type_not_masked(monkeypatch):
    monkeypatch.setattr(rs, 'MAX_TITLE_PAGES', 1)

    def fake_admin_graphql(token, query, variables=None):
        return {'products': {'pageInfo': {'hasNextPage': False, 'endCursor': None}, 'edges': ['not-a-dict']}}

    monkeypatch.setattr(rs, 'admin_graphql', fake_admin_graphql)
    with pytest.raises(rs.RegisterError) as excinfo:
        rs.fetch_all_titles('dummy-token')
    assert 'edge' in str(excinfo.value)
    assert_structural_not_bound(excinfo.value)


def test_page_count_boundary_bad_node_type_not_masked(monkeypatch):
    monkeypatch.setattr(rs, 'MAX_TITLE_PAGES', 1)

    def fake_admin_graphql(token, query, variables=None):
        return {'products': {'pageInfo': {'hasNextPage': False, 'endCursor': None}, 'edges': [{'node': 'not-a-dict'}]}}

    monkeypatch.setattr(rs, 'admin_graphql', fake_admin_graphql)
    with pytest.raises(rs.RegisterError) as excinfo:
        rs.fetch_all_titles('dummy-token')
    assert 'node' in str(excinfo.value)
    assert_structural_not_bound(excinfo.value)


def test_page_count_boundary_bad_title_type_not_masked(monkeypatch):
    monkeypatch.setattr(rs, 'MAX_TITLE_PAGES', 1)

    def fake_admin_graphql(token, query, variables=None):
        return {'products': {'pageInfo': {'hasNextPage': False, 'endCursor': None}, 'edges': [{'node': {'title': 12345}}]}}

    monkeypatch.setattr(rs, 'admin_graphql', fake_admin_graphql)
    with pytest.raises(rs.RegisterError) as excinfo:
        rs.fetch_all_titles('dummy-token')
    assert 'タイトル' in str(excinfo.value)
    assert '非文字列' in str(excinfo.value)
    assert_structural_not_bound(excinfo.value)


def test_page_count_boundary_empty_title_not_masked(monkeypatch):
    monkeypatch.setattr(rs, 'MAX_TITLE_PAGES', 1)

    def fake_admin_graphql(token, query, variables=None):
        return {'products': {'pageInfo': {'hasNextPage': False, 'endCursor': None}, 'edges': [{'node': {'title': '   '}}]}}

    monkeypatch.setattr(rs, 'admin_graphql', fake_admin_graphql)
    with pytest.raises(rs.RegisterError) as excinfo:
        rs.fetch_all_titles('dummy-token')
    assert '空です' in str(excinfo.value)
    assert_structural_not_bound(excinfo.value)


# --- Group B: 「上限ページ数に達しhasNextPage=True」の境界で、構造不正が隠されない ---

def test_page_count_at_limit_hasnext_true_bad_edge_not_masked(monkeypatch):
    monkeypatch.setattr(rs, 'MAX_TITLE_PAGES', 1)

    def fake_admin_graphql(token, query, variables=None):
        return {'products': {'pageInfo': {'hasNextPage': True, 'endCursor': 'c1'}, 'edges': ['not-a-dict']}}

    monkeypatch.setattr(rs, 'admin_graphql', fake_admin_graphql)
    with pytest.raises(rs.RegisterError) as excinfo:
        rs.fetch_all_titles('dummy-token')
    assert 'edge' in str(excinfo.value)
    assert_structural_not_bound(excinfo.value)


def test_page_count_at_limit_hasnext_true_bad_title_not_masked(monkeypatch):
    monkeypatch.setattr(rs, 'MAX_TITLE_PAGES', 1)

    def fake_admin_graphql(token, query, variables=None):
        return {'products': {'pageInfo': {'hasNextPage': True, 'endCursor': 'c1'}, 'edges': [{'node': {'title': None}}]}}

    monkeypatch.setattr(rs, 'admin_graphql', fake_admin_graphql)
    with pytest.raises(rs.RegisterError) as excinfo:
        rs.fetch_all_titles('dummy-token')
    assert '非文字列' in str(excinfo.value)
    assert_structural_not_bound(excinfo.value)


# --- Group C: 商品件数がちょうど上限を超過する境界で、構造不正が隠されない ---

def test_product_count_boundary_bad_edge_type_not_masked(monkeypatch):
    monkeypatch.setattr(rs, 'MAX_EXISTING_PRODUCT_COUNT', 1)

    def fake_admin_graphql(token, query, variables=None):
        return {'products': {'pageInfo': {'hasNextPage': False, 'endCursor': None},
                              'edges': [{'node': {'title': '作家A　品1'}}, 'not-a-dict']}}

    monkeypatch.setattr(rs, 'admin_graphql', fake_admin_graphql)
    with pytest.raises(rs.RegisterError) as excinfo:
        rs.fetch_all_titles('dummy-token')
    assert 'edge' in str(excinfo.value)
    assert_structural_not_bound(excinfo.value)


def test_product_count_boundary_bad_node_type_not_masked(monkeypatch):
    monkeypatch.setattr(rs, 'MAX_EXISTING_PRODUCT_COUNT', 1)

    def fake_admin_graphql(token, query, variables=None):
        return {'products': {'pageInfo': {'hasNextPage': False, 'endCursor': None},
                              'edges': [{'node': {'title': '作家A　品1'}}, {'node': ['not-a-dict']}]}}

    monkeypatch.setattr(rs, 'admin_graphql', fake_admin_graphql)
    with pytest.raises(rs.RegisterError) as excinfo:
        rs.fetch_all_titles('dummy-token')
    assert 'node' in str(excinfo.value)
    assert_structural_not_bound(excinfo.value)


def test_product_count_boundary_bad_title_type_not_masked(monkeypatch):
    monkeypatch.setattr(rs, 'MAX_EXISTING_PRODUCT_COUNT', 1)

    def fake_admin_graphql(token, query, variables=None):
        return {'products': {'pageInfo': {'hasNextPage': False, 'endCursor': None},
                              'edges': [{'node': {'title': '作家A　品1'}}, {'node': {'title': 999}}]}}

    monkeypatch.setattr(rs, 'admin_graphql', fake_admin_graphql)
    with pytest.raises(rs.RegisterError) as excinfo:
        rs.fetch_all_titles('dummy-token')
    assert '非文字列' in str(excinfo.value)
    assert_structural_not_bound(excinfo.value)


def test_product_count_boundary_empty_title_not_masked(monkeypatch):
    monkeypatch.setattr(rs, 'MAX_EXISTING_PRODUCT_COUNT', 1)

    def fake_admin_graphql(token, query, variables=None):
        return {'products': {'pageInfo': {'hasNextPage': False, 'endCursor': None},
                              'edges': [{'node': {'title': '作家A　品1'}}, {'node': {'title': ''}}]}}

    monkeypatch.setattr(rs, 'admin_graphql', fake_admin_graphql)
    with pytest.raises(rs.RegisterError) as excinfo:
        rs.fetch_all_titles('dummy-token')
    assert '空です' in str(excinfo.value)
    assert_structural_not_bound(excinfo.value)


# --- Group D: 不正ページの部分反映禁止・複数ページにまたがる誤マスキング再発防止 ---

def test_invalid_page_does_not_pollute_titles_with_earlier_valid_pages(monkeypatch):
    monkeypatch.setattr(rs, 'MAX_TITLE_PAGES', 10)
    calls = []

    def fake_admin_graphql(token, query, variables=None):
        calls.append(variables.get('cursor'))
        if len(calls) == 1:
            return {'products': {'pageInfo': {'hasNextPage': True, 'endCursor': 'c1'},
                                  'edges': [{'node': {'title': '作家A　正常品'}}]}}
        return {'products': {'pageInfo': {'hasNextPage': False, 'endCursor': None},
                              'edges': [{'node': {'title': 42}}]}}

    monkeypatch.setattr(rs, 'admin_graphql', fake_admin_graphql)
    with pytest.raises(rs.RegisterError) as excinfo:
        rs.fetch_all_titles('dummy-token')
    assert '非文字列' in str(excinfo.value)
    # 1ページ目が正常であっても、2ページ目が不正なら titles は一切確定して返らない
    # （fetch_all_titles は例外送出のみで、部分的な titles を返す経路が存在しないことを確認）
    assert len(calls) == 2


def test_invalid_structural_page_stops_fetch_before_next_page_requested(monkeypatch):
    monkeypatch.setattr(rs, 'MAX_TITLE_PAGES', 10)
    calls = []

    def fake_admin_graphql(token, query, variables=None):
        calls.append(variables.get('cursor'))
        return {'products': {'pageInfo': {'hasNextPage': True, 'endCursor': f'c{len(calls)}'},
                              'edges': [{'node': {'title': '作家A　品'}}, 'not-a-dict']}}

    monkeypatch.setattr(rs, 'admin_graphql', fake_admin_graphql)
    with pytest.raises(rs.RegisterError) as excinfo:
        rs.fetch_all_titles('dummy-token')
    assert 'edge' in str(excinfo.value)
    # 不正ページを検出した時点で即座に停止し、次ページへは進まない
    assert len(calls) == 1


# --- Group E: Luna指摘の再現ケース ---
# 上限をすでに超過した「後」の位置に不正構造のedgeがある場合、
# 旧実装は「先に上限超過エラーで停止」してしまい構造不正を検出できなかった。
# 新実装ではページ全体を先に構造検証するため、必ず構造エラーが検出される。

def test_masked_bug_reproduction_bad_edge_after_count_exceeds(monkeypatch):
    monkeypatch.setattr(rs, 'MAX_EXISTING_PRODUCT_COUNT', 2)

    def fake_admin_graphql(token, query, variables=None):
        return {'products': {'pageInfo': {'hasNextPage': False, 'endCursor': None}, 'edges': [
            {'node': {'title': '作家A　品1'}},
            {'node': {'title': '作家A　品2'}},
            'not-a-dict',
        ]}}

    monkeypatch.setattr(rs, 'admin_graphql', fake_admin_graphql)
    with pytest.raises(rs.RegisterError) as excinfo:
        rs.fetch_all_titles('dummy-token')
    assert 'edge' in str(excinfo.value)
    assert_structural_not_bound(excinfo.value)


def test_masked_bug_reproduction_bad_node_after_count_exceeds(monkeypatch):
    monkeypatch.setattr(rs, 'MAX_EXISTING_PRODUCT_COUNT', 2)

    def fake_admin_graphql(token, query, variables=None):
        return {'products': {'pageInfo': {'hasNextPage': False, 'endCursor': None}, 'edges': [
            {'node': {'title': '作家A　品1'}},
            {'node': {'title': '作家A　品2'}},
            {'node': 123},
        ]}}

    monkeypatch.setattr(rs, 'admin_graphql', fake_admin_graphql)
    with pytest.raises(rs.RegisterError) as excinfo:
        rs.fetch_all_titles('dummy-token')
    assert 'node' in str(excinfo.value)
    assert_structural_not_bound(excinfo.value)


def test_masked_bug_reproduction_bad_title_after_count_exceeds(monkeypatch):
    monkeypatch.setattr(rs, 'MAX_EXISTING_PRODUCT_COUNT', 2)

    def fake_admin_graphql(token, query, variables=None):
        return {'products': {'pageInfo': {'hasNextPage': False, 'endCursor': None}, 'edges': [
            {'node': {'title': '作家A　品1'}},
            {'node': {'title': '作家A　品2'}},
            {'node': {'title': ['bad']}},
        ]}}

    monkeypatch.setattr(rs, 'admin_graphql', fake_admin_graphql)
    with pytest.raises(rs.RegisterError) as excinfo:
        rs.fetch_all_titles('dummy-token')
    assert '非文字列' in str(excinfo.value)
    assert_structural_not_bound(excinfo.value)


def test_masked_bug_reproduction_empty_title_after_count_exceeds(monkeypatch):
    monkeypatch.setattr(rs, 'MAX_EXISTING_PRODUCT_COUNT', 2)

    def fake_admin_graphql(token, query, variables=None):
        return {'products': {'pageInfo': {'hasNextPage': False, 'endCursor': None}, 'edges': [
            {'node': {'title': '作家A　品1'}},
            {'node': {'title': '作家A　品2'}},
            {'node': {'title': '  '}},
        ]}}

    monkeypatch.setattr(rs, 'admin_graphql', fake_admin_graphql)
    with pytest.raises(rs.RegisterError) as excinfo:
        rs.fetch_all_titles('dummy-token')
    assert '空です' in str(excinfo.value)
    assert_structural_not_bound(excinfo.value)
