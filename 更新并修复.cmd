@echo off
rem One-click update: sync the plugin into DSH + patch the desktop shell.
rem ASCII-only body on purpose: a UTF-8 .cmd confuses cmd.exe parsing.
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node.exe not found in PATH.
  echo         Try: "D:\Download\DeepSeekHarness\resources\node\node.exe" scripts\update-all.mjs
  pause
  exit /b 1
)

echo.
echo === Dry run first (writes nothing) ===
echo.
node "scripts\update-all.mjs" --dry
if not "%ERRORLEVEL%"=="0" (
  echo.
  echo [STOP] Dry run failed - nothing was changed.
  pause
  exit /b 1
)

echo.
echo === Apply now? Make sure DSH is fully closed for the shell patch. ===
set /p GO=Apply? (y/N) 
if /i not "%GO%"=="y" (
  echo Cancelled - nothing changed.
  pause
  exit /b 0
)

echo.
node "scripts\update-all.mjs"
echo.
pause
