@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set PORT=8765

echo 澄文扫描台 - 本地预览服务
echo 目录: %cd%
echo 地址: http://127.0.0.1:%PORT%/
echo.
echo 若浏览器比服务先打开、显示"无法访问"，刷新一次即可。
echo.

rem 优先用自带的零依赖服务：MIME、缓存与路径校验都由本项目负责
where node >nul 2>nul
if %errorlevel%==0 goto useNode

echo 未找到 Node.js，改用 Python 静态服务器...
start "" "http://127.0.0.1:%PORT%/"
python -m http.server %PORT% --bind 127.0.0.1
goto done

:useNode
start "" "http://127.0.0.1:%PORT%/"
node serve.js

:done
echo.
echo 服务已停止。按任意键关闭。
pause >nul
