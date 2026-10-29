#Requires -Version 5.1
<#
.SYNOPSIS
  PS5 插件更新中心 - Windows 安装脚本
.DESCRIPTION
  1. 检测 Node.js（必需）与 Git（推荐）；缺失时打开官方下载页并等待用户安装
  2. 将应用安装到当前用户目录（无需管理员权限）
  3. 创建桌面与开始菜单快捷方式
  4. 启动应用
.NOTES
  用法：右键 install.ps1 -> 使用 PowerShell 运行；
  若提示执行策略限制，可在 PowerShell 中运行：
    Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
  然后重新执行本脚本。
#>

$ErrorActionPreference = 'Stop'

# ---------- 配置 ----------
$AppName    = 'PS5 插件更新中心'
$AppDirName = 'PS5-Plugin-Hub'
$InstallDir = Join-Path $env:LOCALAPPDATA $AppDirName
$NodeUrl    = 'https://nodejs.org/zh-cn/download'
$GitUrl     = 'https://git-scm.com/download/win'
$Port       = 8123

# 脚本所在目录（即解压后的 dist 目录）
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SourceDir = Join-Path $ScriptDir 'app'

$LogFile = Join-Path $env:TEMP 'ps5-plugin-hub-install.log'
function Write-Log($msg) {
  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  "[$stamp] $msg" | Add-Content -Path $LogFile -Encoding UTF8
}

function Pause-HitKey {
  Write-Host '按任意键继续...' -ForegroundColor Cyan
  $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
}

# ---------- 检测 Node.js ----------
function Test-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) {
    try {
      $ver = & node --version 2>$null
      Write-Log "检测到 Node.js: $ver ($($cmd.Source))"
      return $true
    } catch {}
  }
  # 检查常见安装路径
  $candidates = @(
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe",
    "$env:APPDATA\npm\node.exe"
  )
  foreach ($p in $candidates) {
    if (Test-Path $p) {
      Write-Log "检测到 Node.js: $p"
      return $true
    }
  }
  return $false
}

function Wait-ForNode {
  Write-Host ''
  Write-Host '[依赖检查] 未检测到 Node.js（必需）。' -ForegroundColor Yellow
  Write-Host '  正在打开 Node.js 官方下载页，请下载并安装 LTS 版本...' -ForegroundColor Yellow
  try { Start-Process $NodeUrl } catch { Write-Host "  请手动访问: $NodeUrl" -ForegroundColor Yellow }
  Write-Host ''
  do {
    Write-Host '安装完成后请按回车键继续检测...' -ForegroundColor Cyan -NoNewline
    Read-Host | Out-Null
    $ok = Test-Node
    if (-not $ok) { Write-Host '  仍未检测到 Node.js，请确认已安装。' -ForegroundColor Red }
  } while (-not $ok)
  Write-Host '[依赖检查] Node.js 已就绪。' -ForegroundColor Green
}

# ---------- 检测 Git ----------
function Test-Git {
  $cmd = Get-Command git -ErrorAction SilentlyContinue
  if ($cmd) {
    try {
      $ver = & git --version 2>$null
      Write-Log "检测到 Git: $ver"
      return $true
    } catch {}
  }
  return $false
}

function Wait-ForGit {
  Write-Host ''
  Write-Host '[依赖检查] 未检测到 Git（推荐）。' -ForegroundColor Yellow
  Write-Host '  同步功能优先使用 git pull；未安装时会自动改用 GitHub 直连下载。' -ForegroundColor DarkYellow
  Write-Host '  正在打开 Git 官方下载页...' -ForegroundColor Yellow
  try { Start-Process $GitUrl } catch { Write-Host "  请手动访问: $GitUrl" -ForegroundColor Yellow }
  Write-Host ''
  do {
    Write-Host '已安装请按回车继续；跳过请输入 s 后回车：' -ForegroundColor Cyan -NoNewline
    $ans = (Read-Host).Trim().ToLower()
    if ($ans -eq 's') { Write-Host '  已跳过 Git 安装（同步将使用在线下载）。' -ForegroundColor DarkYellow; return }
    $ok = Test-Git
    if (-not $ok) { Write-Host '  仍未检测到 Git。' -ForegroundColor Red }
  } while (-not $ok)
  Write-Host '[依赖检查] Git 已就绪。' -ForegroundColor Green
}

# ---------- 安装主体 ----------
function Install-App {
  if (-not (Test-Path $SourceDir)) {
    throw "找不到应用源目录: $SourceDir。请确认安装包已完整解压。"
  }
  Write-Log "开始安装到 $InstallDir"
  if (Test-Path $InstallDir) {
    Write-Host "目标目录已存在，将更新其中的文件: $InstallDir" -ForegroundColor DarkYellow
  } else {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  }

  # 复制应用文件（覆盖），保留用户数据目录
  $excludeDirs = @('downloads', 'logs', 'state', 'cheats')
  Get-ChildItem -Path $SourceDir -Force | ForEach-Object {
    $dst = Join-Path $InstallDir $_.Name
    if ($_.PSIsContainer -and $excludeDirs -contains $_.Name) {
      # 运行时目录不覆盖
      if (-not (Test-Path $dst)) { Copy-Item $_.FullName $dst -Recurse -Force }
      return
    }
    Copy-Item $_.FullName $dst -Recurse -Force
  }

  # 复制启动器与卸载脚本
  Copy-Item (Join-Path $ScriptDir 'start.bat') (Join-Path $InstallDir 'start.bat') -Force
  Copy-Item (Join-Path $ScriptDir 'uninstall.ps1') (Join-Path $InstallDir 'uninstall.ps1') -Force
  Copy-Item (Join-Path $ScriptDir 'install.ps1') (Join-Path $InstallDir 'install.ps1') -Force

  Write-Log "文件复制完成"
}

# ---------- 创建快捷方式 ----------
function New-Shortcut($targetPath, $args, $workingDir, $shortcutPath, $iconLocation, $description) {
  try {
    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut($shortcutPath)
    $sc.TargetPath = $targetPath
    if ($args) { $sc.Arguments = $args }
    if ($workingDir) { $sc.WorkingDirectory = $workingDir }
    if ($iconLocation) { $sc.IconLocation = $iconLocation }
    if ($description) { $sc.Description = $description }
    $sc.Save()
    return $true
  } catch {
    Write-Log "创建快捷方式失败: $($_.Exception.Message)"
    return $false
  }
}

function Create-Shortcuts {
  $startBat = Join-Path $InstallDir 'start.bat'
  $desktop = [Environment]::GetFolderPath('Desktop')
  $startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) $AppName

  if (-not (Test-Path $startMenu)) { New-Item -ItemType Directory -Path $startMenu -Force | Out-Null }

  $desktopLnk = Join-Path $desktop "$AppName.lnk"
  $startLnk   = Join-Path $startMenu "$AppName.lnk"
  $uninstallLnk = Join-Path $startMenu "卸载 $AppName.lnk"

  $icon = ''
  $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
  if ($nodeExe) { $icon = "$nodeExe,0" }

  $ok1 = New-Shortcut $startBat '' $InstallDir $desktopLnk $icon $AppName
  $ok2 = New-Shortcut $startBat '' $InstallDir $startLnk $icon $AppName
  $ok3 = New-Shortcut 'powershell.exe' "-ExecutionPolicy Bypass -File `"$InstallDir\uninstall.ps1`"" $InstallDir $uninstallLnk '' "卸载 $AppName"

  if ($ok1) { Write-Log "已创建桌面快捷方式" } else { Write-Host '  桌面快捷方式创建失败' -ForegroundColor Red }
  if ($ok2) { Write-Log "已创建开始菜单快捷方式" } else { Write-Host '  开始菜单快捷方式创建失败' -ForegroundColor Red }
}

# ---------- 启动应用 ----------
function Start-App {
  $startBat = Join-Path $InstallDir 'start.bat'
  Write-Host ''
  Write-Host '正在启动应用...' -ForegroundColor Green
  Start-Process $startBat -WorkingDirectory $InstallDir
  Start-Sleep -Seconds 2
  try {
    Start-Process "http://127.0.0.1:$Port"
  } catch {}
}

# ---------- 主流程 ----------
function Main {
  Write-Host ''
  Write-Host '========================================' -ForegroundColor Cyan
  Write-Host "  $AppName 安装程序" -ForegroundColor Cyan
  Write-Host '========================================' -ForegroundColor Cyan
  Write-Host ''

  Write-Log "==== 安装开始 ===="

  # 1. 依赖检查
  if (-not (Test-Node)) { Wait-ForNode } else { Write-Host '[依赖检查] Node.js 已就绪。' -ForegroundColor Green }
  if (-not (Test-Git)) { Wait-ForGit } else { Write-Host '[依赖检查] Git 已就绪。' -ForegroundColor Green }

  # 2. 安装文件
  Write-Host ''
  Write-Host '[安装] 正在复制应用文件...' -ForegroundColor Cyan
  Install-App
  Write-Host '[安装] 文件复制完成。' -ForegroundColor Green

  # 3. 快捷方式
  Write-Host '[安装] 正在创建快捷方式...' -ForegroundColor Cyan
  Create-Shortcuts
  Write-Host '[安装] 快捷方式创建完成。' -ForegroundColor Green

  # 4. 启动
  Start-App

  Write-Host ''
  Write-Host '========================================' -ForegroundColor Green
  Write-Host "  $AppName 安装完成！" -ForegroundColor Green
  Write-Host "  安装目录: $InstallDir" -ForegroundColor Green
  Write-Host '========================================' -ForegroundColor Green
  Write-Host ''
  Write-Log "==== 安装完成 ===="
  Pause-HitKey
}

try {
  Main
} catch {
  Write-Host ''
  Write-Host "[安装失败] $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "详细日志: $LogFile" -ForegroundColor DarkYellow
  Write-Log "安装失败: $($_.Exception.Message)"
  Pause-HitKey
  exit 1
}
