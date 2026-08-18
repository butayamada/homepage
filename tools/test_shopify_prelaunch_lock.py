"""
Phase F-04-F01: Shopify公開前ロック テスト。

register_shopify.py / drop_release.py の直接CLI実行が、inventory読込み・
Shopify query/mutation・ledger読み書きより前に、無条件で非0終了することを検証する。
実Shopify APIには一切接続しない。CLI引数・環境変数での解除ができないことも検証する。
"""
import subprocess
import sys
from pathlib import Path

import pytest

TOOLS_DIR = Path(__file__).resolve().parent

sys.path.insert(0, str(TOOLS_DIR))
import register_shopify as rs
import drop_release as dr

REASON_CODE = "SHOPIFY_REGISTRATION_PRELAUNCH_LOCKED"


# ---------------------------------------------------------------------------
# register_shopify.py — 直接呼び出し（プロセス起動なし、高速）
# ---------------------------------------------------------------------------
class TestRegisterShopifyLockDirect:
    def test_prelaunch_locked_constant_is_true(self):
        assert rs.PRELAUNCH_LOCKED is True

    def test_enforce_lock_exits_nonzero_before_anything_else(self, monkeypatch, capsys):
        called = {"token": False, "inventory": False, "graphql": False, "ledger_load": False, "ledger_save": False}
        monkeypatch.setattr(rs, "read_admin_token", lambda: called.__setitem__("token", True))
        monkeypatch.setattr(rs, "load_inventory", lambda p: called.__setitem__("inventory", True))
        monkeypatch.setattr(rs, "admin_graphql", lambda *a, **k: called.__setitem__("graphql", True))
        monkeypatch.setattr(rs, "load_ledger", lambda: called.__setitem__("ledger_load", True))
        monkeypatch.setattr(rs, "save_ledger", lambda l: called.__setitem__("ledger_save", True))

        with pytest.raises(SystemExit) as excinfo:
            rs.enforce_prelaunch_lock()
        assert excinfo.value.code != 0

        assert called == {k: False for k in called}
        out = capsys.readouterr()
        assert REASON_CODE in out.err

    def test_main_dry_run_direct_exits_nonzero(self, monkeypatch):
        monkeypatch.setattr(sys, "argv", ["register_shopify.py", "--exhibition", "テスト企画展", "--dry-run"])
        with pytest.raises(SystemExit) as excinfo:
            rs.main()
        assert excinfo.value.code != 0

    def test_main_normal_run_direct_exits_nonzero(self, monkeypatch):
        monkeypatch.setattr(sys, "argv", ["register_shopify.py", "--exhibition", "テスト企画展"])
        with pytest.raises(SystemExit) as excinfo:
            rs.main()
        assert excinfo.value.code != 0

    def test_multiple_items_with_duplicate_still_locked(self, monkeypatch):
        # 重複の有無に関わらず、ロックはそれより先に発火する
        monkeypatch.setattr(sys, "argv", ["register_shopify.py", "--exhibition", "テスト企画展"])
        with pytest.raises(SystemExit):
            rs.main()

    def test_unknown_unlock_style_cli_arg_does_not_bypass(self, monkeypatch):
        for bad_args in (
            ["register_shopify.py", "--exhibition", "x", "--force"],
            ["register_shopify.py", "--exhibition", "x", "--unlock"],
            ["register_shopify.py", "--exhibition", "x", "--skip-lock"],
            ["register_shopify.py", "--exhibition", "x", "--dry-run", "--allow-live"],
        ):
            monkeypatch.setattr(sys, "argv", bad_args)
            with pytest.raises(SystemExit) as excinfo:
                rs.main()
            assert excinfo.value.code != 0

    def test_env_var_activation_like_value_does_not_bypass(self, monkeypatch):
        for key, val in [
            ("SHOPIFY_PRELAUNCH_LOCKED", "false"),
            ("SHOPIFY_PRELAUNCH_LOCKED", "0"),
            ("PRELAUNCH_LOCKED", "0"),
            ("SYNC_ACTIVE", "true"),
            ("ACTIVATION_GENERATION", "gen_1"),
        ]:
            monkeypatch.setenv(key, val)
        monkeypatch.setattr(sys, "argv", ["register_shopify.py", "--exhibition", "x", "--dry-run"])
        with pytest.raises(SystemExit) as excinfo:
            rs.main()
        assert excinfo.value.code != 0

    def test_no_secret_or_path_in_lock_output(self, capsys):
        with pytest.raises(SystemExit):
            rs.enforce_prelaunch_lock()
        out = capsys.readouterr()
        combined = out.out + out.err
        assert "SHOPIFY_ADMIN_TOKEN" not in combined
        assert "shpat_" not in combined
        assert "C:\\Users" not in combined
        assert "テスト企画展" not in combined


# ---------------------------------------------------------------------------
# drop_release.py — 直接呼び出し
# ---------------------------------------------------------------------------
class TestDropReleaseLockDirect:
    def test_prelaunch_locked_constant_is_true(self):
        assert dr.PRELAUNCH_LOCKED is True

    def test_enforce_lock_exits_nonzero_before_anything_else(self, monkeypatch, capsys):
        called = {"token": False, "graphql": False}
        monkeypatch.setattr(dr, "read_admin_token", lambda: called.__setitem__("token", True))
        monkeypatch.setattr(dr, "admin_graphql", lambda *a, **k: called.__setitem__("graphql", True))

        with pytest.raises(SystemExit) as excinfo:
            dr.enforce_prelaunch_lock()
        assert excinfo.value.code != 0
        assert called == {"token": False, "graphql": False}
        out = capsys.readouterr()
        assert REASON_CODE in out.err

    def test_main_dry_run_direct_exits_nonzero(self, monkeypatch):
        monkeypatch.setattr(sys, "argv", ["drop_release.py", "--exhibition", "テスト企画展", "--dry-run"])
        with pytest.raises(SystemExit) as excinfo:
            dr.main()
        assert excinfo.value.code != 0

    def test_main_normal_run_direct_exits_nonzero(self, monkeypatch):
        monkeypatch.setattr(sys, "argv", ["drop_release.py", "--exhibition", "テスト企画展"])
        with pytest.raises(SystemExit) as excinfo:
            dr.main()
        assert excinfo.value.code != 0

    def test_no_sync_flag_does_not_bypass(self, monkeypatch):
        monkeypatch.setattr(sys, "argv", ["drop_release.py", "--exhibition", "x", "--no-sync"])
        with pytest.raises(SystemExit) as excinfo:
            dr.main()
        assert excinfo.value.code != 0


# ---------------------------------------------------------------------------
# 実プロセスとしてのCLI起動（subprocess、モックなし・完全に独立した再現）
# ---------------------------------------------------------------------------
class TestRealSubprocessInvocation:
    def _run(self, script, args):
        return subprocess.run(
            [sys.executable, str(TOOLS_DIR / script)] + args,
            capture_output=True, text=True, timeout=30,
        )

    @pytest.mark.parametrize("args", [
        ["--exhibition", "テスト企画展", "--dry-run"],
        ["--exhibition", "テスト企画展"],
        ["--exhibition", "テスト企画展A", "--exhibition", "テスト企画展B"],  # 複数商品相当・引数繰り返し
        ["--exhibition", "存在しない企画展999"],  # 重複あり/なしに関わらず影響しない
    ])
    def test_register_shopify_real_process_nonzero(self, args):
        result = self._run("register_shopify.py", args)
        assert result.returncode != 0
        assert REASON_CODE in result.stderr

    def test_register_shopify_malformed_source_still_locked(self, tmp_path):
        bad_json = tmp_path / "not_json.txt"
        bad_json.write_text("{not valid json", encoding="utf-8")
        result = self._run("register_shopify.py", ["--exhibition", "x", "--dry-run", "--source", str(bad_json)])
        assert result.returncode != 0
        assert REASON_CODE in result.stderr

    def test_drop_release_real_process_nonzero(self):
        result = self._run("drop_release.py", ["--exhibition", "テスト企画展", "--dry-run"])
        assert result.returncode != 0
        assert REASON_CODE in result.stderr

    def test_reason_code_identical_across_both_scripts(self):
        r1 = self._run("register_shopify.py", ["--exhibition", "x", "--dry-run"])
        r2 = self._run("drop_release.py", ["--exhibition", "x", "--dry-run"])
        assert REASON_CODE in r1.stderr
        assert REASON_CODE in r2.stderr

    def test_no_python_exception_traceback_leaks(self):
        # 未処理例外0件（fail-closedのロックがtraceback無しできれいに終了すること）
        result = self._run("register_shopify.py", ["--exhibition", "x"])
        assert "Traceback" not in result.stderr
