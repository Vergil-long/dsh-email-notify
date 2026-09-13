@echo off
rem dsh-email-notify installer (double-click me).
rem ASCII-only on purpose: a UTF-8 .cmd body confuses cmd.exe parsing.
rem All user-facing Chinese text comes from scripts\install.mjs.
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node.exe not found in PATH.
  echo         Install Node.js or run: "D:\Download\DeepSeekHarness\resources\node\node.exe" scripts\install.mjs
  pause
  exit /b 1
)

echo.
echo === Installing dsh-email-notify into the DSH web profile ===
echo.
node "scripts\install.mjs" %*
set RC=%ERRORLEVEL%
echo.

if not "%RC%"=="0" (
  echo [ERROR] install failed with exit code %RC%
  pause
  exit /b %RC%
)

echo === Done ===
echo Next: restart DeepSeek Harness, then open  Settings - Email notifications
echo       (设置 - 邮件通知) and fill in your mail account there.
echo       No need to edit config.json by hand anymore.
pause
