@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ARC FUKAMEKI - 企画展 Shopify登録
echo.
set /p EXHIBITION=企画展名を入力してください:

echo.
echo === 登録予定プレビュー（%EXHIBITION%） ===
python register_shopify.py --exhibition "%EXHIBITION%" --dry-run
echo.

set /p CONFIRM=この内容で登録しますか？ (y/n):
if /i not "%CONFIRM%"=="y" (
  echo 中止しました。
  pause
  exit /b
)

echo.
echo === 登録実行 ===
python register_shopify.py --exhibition "%EXHIBITION%"

echo.
pause
