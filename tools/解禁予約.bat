@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ARC FUKAMEKI - 企画展ドロップ予約
echo.
set /p EXHIBITION=企画展名を入力してください:

echo.
echo === 対象一覧プレビュー（%EXHIBITION%） ===
python drop_release.py --exhibition "%EXHIBITION%" --dry-run
echo.

set /p DROPDATE=解禁日付を入力してください（例: 2026/08/01）:
set /p DROPTIME=解禁時刻を入力してください（例: 20:00）:

schtasks /create /tn "fukameki-drop" /tr "python \"%~dp0drop_release.py\" --exhibition \"%EXHIBITION%\"" /sc once /sd %DROPDATE% /st %DROPTIME% /f

echo.
echo === 予約内容 ===
schtasks /query /tn "fukameki-drop" /v /fo list

echo.
echo 上の内容を確認してください。
pause
