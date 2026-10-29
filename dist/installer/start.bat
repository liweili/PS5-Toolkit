@echo off
setlocal
cd /d "%~dp0"

REM 检测 Node.js
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node.js (https://nodejs.org/)
  echo.
  pause
  exit /b 1
)

REM 检测服务是否已在运行
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8123/api/ping' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>nul
if %errorlevel% equ 0 (
  echo 服务已在运行，直接打开页面...
  start "" "http://127.0.0.1:8123/?today=1"
  exit /b 0
)

echo 正在启动 PS5 插件更新中心...
REM 后台启动服务（隐藏窗口）
start "" /b node --use-system-ca "local\scripts\server.js"

REM 等待服务就绪
set /a tries=0
:wait
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8123/api/ping' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>nul
if %errorlevel% equ 0 (
  echo 启动成功，正在打开浏览器...
  start "" "http://127.0.0.1:8123/?today=1"
  exit /b 0
)
set /a tries+=1
if %tries% geq 30 (
  echo 启动超时，请检查日志或手动运行 install 目录下的 uninstall 后重装。
  pause
  exit /b 1
)
timeout /t 1 /nobreak >nul
goto wait
