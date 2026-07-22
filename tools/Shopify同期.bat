@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ARC FUKAMEKI - Shopify商品同期を実行します
echo.
python sync_shopify.py
echo.
echo ---------------------------------------------
echo 上のレポートを確認してください。
pause
