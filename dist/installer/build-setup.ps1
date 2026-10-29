#Requires -Version 5.1
<#
.SYNOPSIS
  构建 PS5 插件更新中心的安装程序 EXE（带 GUI 目录选择 + 快捷方式）。
.DESCRIPTION
  使用 C# WinForms 安装器 + ZIP 自解压方式。EXE 内含 node.exe + 应用文件，
  运行后弹出安装向导：选择安装目录、勾选快捷方式，解压并创建快捷方式，
  最后自动启动本地服务并打开浏览器 http://127.0.0.1:8123。
  无需安装 Node.js，无需管理员权限。
#>
$ErrorActionPreference = 'Stop'

# 路径说明：
#   $ScriptDir = dist/installer/  （本脚本所在目录，存放安装器源码与构建脚本）
#   $DistDir   = dist/            （发布目录）
#   $RepoRoot  = 仓库根目录
#   $ReleaseDir = dist/release/   （最终产物输出目录）
$ScriptDir = $PSScriptRoot
$DistDir   = Split-Path -Parent $ScriptDir
$RepoRoot  = Split-Path -Parent $DistDir
$ReleaseDir = Join-Path $DistDir 'release'
$StageDir = Join-Path $ScriptDir 'setup-src'
$ZipPath  = Join-Path $ScriptDir 'setup-app.zip'
$InstallerCs = Join-Path $ScriptDir 'installer.cs'
$InstallerExe = Join-Path $ScriptDir 'installer.exe'
$IconPath = Join-Path $ScriptDir 'app.ico'
$ExePath  = Join-Path $ReleaseDir 'PS5-Plugin-Hub-Setup.exe'

$Csc      = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$NodeExe  = 'C:\Program Files\nodejs\node.exe'

Write-Host "仓库根目录: $RepoRoot"
Write-Host "安装器目录: $ScriptDir"
Write-Host "产物目录:   $ReleaseDir"
Write-Host "C# 编译器: $Csc"
Write-Host "Node:      $NodeExe"
Write-Host "图标:      $IconPath"

if (-not (Test-Path $Csc))     { throw "未找到 csc.exe: $Csc" }
if (-not (Test-Path $NodeExe)) { throw "未找到 node.exe: $NodeExe" }
if (-not (Test-Path $IconPath)) { throw "未找到图标: $IconPath，请先运行 make-icon.ps1" }
if (-not (Test-Path $ReleaseDir)) { New-Item -ItemType Directory -Path $ReleaseDir -Force | Out-Null }

# ---------- 清理 ----------
foreach ($p in @($StageDir, $ZipPath, $InstallerExe, $ExePath)) {
  if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}
New-Item -ItemType Directory -Path $StageDir -Force | Out-Null

# ---------- 复制应用文件 ----------
function Copy-Needed($src, $dst) {
  if (-not (Test-Path $src)) { Write-Warning "源不存在，跳过: $src"; return }
  $parent = Split-Path $dst
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  $item = Get-Item $src
  if ($item.PSIsContainer) {
    if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
    Copy-Item $src $dst -Recurse -Force
  } else {
    Copy-Item $src $dst -Force
  }
}

# 上游数据
Copy-Needed (Join-Path $RepoRoot 'json\repos-database.json') (Join-Path $StageDir 'json\repos-database.json')

# 本地应用核心（不包含 downloads/logs/state/cheats）
Copy-Needed (Join-Path $RepoRoot 'local\scripts')        (Join-Path $StageDir 'local\scripts')
Copy-Needed (Join-Path $RepoRoot 'local\site')           (Join-Path $StageDir 'local\site')
Copy-Needed (Join-Path $RepoRoot 'local\i18n')           (Join-Path $StageDir 'local\i18n')
Copy-Needed (Join-Path $RepoRoot 'local\config.json')    (Join-Path $StageDir 'local\config.json')
Copy-Needed (Join-Path $RepoRoot 'local\start.ps1')      (Join-Path $StageDir 'local\start.ps1')
Copy-Needed (Join-Path $RepoRoot 'local\run-daily.ps1')  (Join-Path $StageDir 'local\run-daily.ps1')

# node.exe（运行时）
Copy-Item $NodeExe (Join-Path $StageDir 'node.exe') -Force

# uninstall.ps1
Copy-Item (Join-Path $ScriptDir 'uninstall.ps1') (Join-Path $StageDir 'uninstall.ps1') -Force

# ---------- start.bat（使用内置 node.exe，ASCII 兼容中文 Windows cmd） ----------
$startBat = @'
@echo off
setlocal
cd /d "%~dp0"

REM Check if server is already running
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8123/api/ping' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>nul
if %errorlevel% equ 0 (
  start "" "http://127.0.0.1:8123/?today=1"
  exit /b 0
)

REM Start server with bundled node.exe (truly detached via VBScript)
echo Set WshShell = CreateObject("WScript.Shell") > "%temp%\ps5-run.vbs"
echo WshShell.Run """%~dp0node.exe"" --use-system-ca ""local\scripts\server.js""", 0, False >> "%temp%\ps5-run.vbs"
cscript //nologo "%temp%\ps5-run.vbs"
del "%temp%\ps5-run.vbs" >nul 2>nul

set /a tries=0
:wait
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8123/api/ping' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>nul
if %errorlevel% equ 0 (
  start "" "http://127.0.0.1:8123/?today=1"
  exit /b 0
)
set /a tries+=1
if %tries% geq 30 (
  echo Start failed. Please check logs.
  pause
  exit /b 1
)
timeout /t 1 /nobreak >nul
goto wait
'@
[System.IO.File]::WriteAllText((Join-Path $StageDir 'start.bat'), $startBat, (New-Object System.Text.UTF8Encoding $false))

# ---------- 编译 C# 安装器 ----------
Write-Host '编译 C# 安装器...'
& $Csc /out:$InstallerExe /target:winexe /win32icon:$IconPath `
  /reference:System.Windows.Forms.dll /reference:System.Drawing.dll `
  /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll `
  $InstallerCs 2>&1 | ForEach-Object { Write-Host $_ }
if (-not (Test-Path $InstallerExe)) { throw "C# 安装器编译失败" }
Write-Host ("  安装器大小: {0:N0} 字节" -f (Get-Item $InstallerExe).Length)

# ---------- 创建 ZIP ----------
Write-Host '创建 ZIP 压缩包...'
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($StageDir, $ZipPath, [System.IO.Compression.CompressionLevel]::Optimal, $false)
$zipSize = (Get-Item $ZipPath).Length / 1MB
Write-Host ("  ZIP 大小: {0:N1} MB" -f $zipSize)

# ---------- 拼接 installer.exe + zip → 最终安装包 EXE ----------
Write-Host '生成最终安装包 EXE...'
$wb = [System.IO.File]::ReadAllBytes($InstallerExe)
$zb = [System.IO.File]::ReadAllBytes($ZipPath)
$fs = New-Object System.IO.FileStream($ExePath, [System.IO.FileMode]::Create)
try {
  $fs.Write($wb, 0, $wb.Length)
  $fs.Write($zb, 0, $zb.Length)
} finally { $fs.Close() }

if (-not (Test-Path $ExePath)) { throw "安装包 EXE 生成失败: $ExePath" }
$exeSize = (Get-Item $ExePath).Length / 1MB

# ---------- 清理中间文件 ----------
Remove-Item $InstallerExe -Force -ErrorAction SilentlyContinue
Remove-Item $ZipPath -Force -ErrorAction SilentlyContinue
Remove-Item $StageDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '========================================' -ForegroundColor Green
Write-Host '  构建完成' -ForegroundColor Green
Write-Host '========================================' -ForegroundColor Green
Write-Host "  安装包: $ExePath"
Write-Host ("  大小: {0:N1} MB" -f $exeSize)
Write-Host ''
Write-Host '使用说明:' -ForegroundColor Cyan
Write-Host '  1. 将 PS5-Plugin-Hub-Setup.exe 发送给用户'
Write-Host '  2. 用户双击运行，选择安装目录并点击"安装"'
Write-Host '  3. 安装完成后自动启动，浏览器打开 http://127.0.0.1:8123'
Write-Host '  4. 卸载：开始菜单 -> 卸载 PS5 插件更新中心'
