@echo off
setlocal
cd /d "%~dp0"

echo Chengwen DocScan - GitHub sync helper
echo Folder: %cd%
echo.

where node >nul 2>nul
if errorlevel 1 goto noNode

rem Step 1: find a route that really reaches github.com (direct, or a local proxy
rem         verified by git ls-remote). Step 2: push origin main.
rem This does NOT modify the repo config.
node tools\gitsync.js push
echo.
echo Tip: run "node tools\gitsync.js set" once to pin the working route into
echo      this repo, so a plain "git push" works too.
goto done

:noNode
echo Node.js not found. Install Node.js 16 or newer first.
goto done

:done
echo.
echo Press any key to close.
pause >nul
