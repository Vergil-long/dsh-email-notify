@echo off
rem Apply the desktop-shell completion-notification fix (double-click me).
rem ASCII-only body on purpose: a UTF-8 .cmd confuses cmd.exe parsing.
rem Chinese output comes from the node script.
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node.exe not found in PATH.
  pause
  exit /b 1
)

echo.
echo === Checking the patch (dry run, writes nothing) ===
echo.
node "patch-completion-notify.mjs" --dry
if not "%ERRORLEVEL%"=="0" (
  echo.
  echo [STOP] Dry run failed - nothing was changed. Read the message above.
  pause
  exit /b 1
)

echo.
echo === This will replace app.asar. Make sure DSH is fully closed. ===
set /p GO=Apply now? (y/N) 
if /i not "%GO%"=="y" (
  echo Cancelled - nothing changed.
  pause
  exit /b 0
)

echo.
node "patch-completion-notify.mjs"
set RC=%ERRORLEVEL%
echo.
if not "%RC%"=="0" (
  echo [ERROR] patch failed with exit code %RC%
) else (
  echo Done. Start DSH again and check that the "task completed" toast
  echo only appears when a task has actually finished.
)
pause
