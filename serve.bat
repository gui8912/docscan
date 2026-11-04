@echo off
setlocal
cd /d "%~dp0"
if not defined PORT set PORT=8765

echo Chengwen DocScan - local preview server
echo Folder: %cd%
echo URL:    http://127.0.0.1:%PORT%/
echo.
echo If the browser opens before the server is ready, just refresh once.
echo See README.md and the Chinese guide beside this script for details.
echo.

rem Prefer the project's own zero-dependency server: it owns MIME, cache and path checks.
where node >nul 2>nul
if %errorlevel%==0 goto useNode

echo Node.js not found. Falling back to Python http.server (reduced features).
where python >nul 2>nul
if errorlevel 1 goto noRuntime
start "" "http://127.0.0.1:%PORT%/"
python -m http.server %PORT% --bind 127.0.0.1
goto done

:useNode
start "" "http://127.0.0.1:%PORT%/"
node serve.js
goto done

:noRuntime
echo Neither Node.js nor Python was found.
echo Install Node.js, then run: node serve.js
goto done

:done
echo.
echo Server stopped. Press any key to close.
pause >nul
