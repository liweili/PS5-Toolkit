#Requires -Version 5.1
<#
.SYNOPSIS
  PS5 插件更新中心 - 卸载脚本
#>
$ErrorActionPreference = 'SilentlyContinue'

$AppName    = 'PS5 插件更新中心'
$InstallDir = $PSScriptRoot

function Pause-HitKey {
  Write-Host '按任意键继续...' -ForegroundColor Cyan
  try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch {}
}

Write-Host ''
Write-Host '========================================' -ForegroundColor Cyan
Write-Host "  卸载 $AppName" -ForegroundColor Cyan
Write-Host '========================================' -ForegroundColor Cyan
Write-Host ''

# 卸载脚本通常以安装目录作为工作目录启动，而 Windows 不允许删除任何正在运行进程的
# 当前工作目录，这就是之前「只删掉图标、程序还在」的主要原因。
# 注意：仅 Set-Location 不会改变进程的 Win32 工作目录，必须同时设置 CurrentDirectory。
try {
  Set-Location -LiteralPath $env:TEMP
  [Environment]::CurrentDirectory = $env:TEMP
} catch {}

# ---------- 停止服务进程 ----------
Write-Host '[卸载] 正在停止服务...' -ForegroundColor Cyan
$selfId = $PID

# 1) 命令行指向安装目录或 server.js 的 node / cmd 进程
try {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    if (-not $_ -or $_.ProcessId -eq $selfId) { return $false }
    $cl = $_.CommandLine
    if (-not $cl) { return $false }
    if ($_.Name -eq 'node.exe') {
      return ($cl -like "*$InstallDir*" -or $cl -like '*local\scripts\server.js*' -or $cl -like '*local/scripts/server.js*')
    }
    if ($_.Name -eq 'cmd.exe') { return ($cl -like "*$InstallDir*" -and $cl -like '*start.bat*') }
    return $false
  } | ForEach-Object {
    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
  }
} catch {}

# 2) 可执行文件位于安装目录内的进程（如打包自带的 node.exe）
try {
  Get-Process -ErrorAction SilentlyContinue | Where-Object {
    if ($_.Id -eq $selfId) { return $false }
    try { $exePath = $_.Path } catch { return $false }
    return ($exePath -and $exePath.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase))
  } | ForEach-Object {
    try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch {}
  }
} catch {}

# 给进程一点时间释放文件锁
Start-Sleep -Milliseconds 800

# ---------- 删除快捷方式 ----------
$desktop = [Environment]::GetFolderPath('Desktop')
$programs = [Environment]::GetFolderPath('Programs')
$startMenuDir = Join-Path $programs $AppName

Remove-Item (Join-Path $desktop "$AppName.lnk") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $desktop "卸载 $AppName.lnk") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $desktop "Uninstall $AppName.lnk") -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $startMenuDir) {
  Remove-Item $startMenuDir -Recurse -Force -ErrorAction SilentlyContinue
}
Remove-Item (Join-Path $programs "卸载 $AppName.lnk") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $programs "Uninstall $AppName.lnk") -Force -ErrorAction SilentlyContinue

# ---------- 删除安装目录 ----------
function Clear-ReadOnly([string]$dir) {
  if (-not (Test-Path -LiteralPath $dir)) { return }
  Get-ChildItem -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      if ($_.Attributes -band [System.IO.FileAttributes]::ReadOnly) {
        $_.Attributes = $_.Attributes -bxor [System.IO.FileAttributes]::ReadOnly
      }
    } catch {}
  }
}

# 单次删除失败时不再中止整个卸载流程，改为清只读属性 + 重试
function Remove-PathHard([string]$target) {
  if (-not (Test-Path -LiteralPath $target)) { return $true }
  for ($i = 0; $i -lt 10; $i++) {
    try {
      Clear-ReadOnly $target
      Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
    } catch {}
    if (-not (Test-Path -LiteralPath $target)) { return $true }
    Start-Sleep -Milliseconds 400
  }
  return (-not (Test-Path -LiteralPath $target))
}

if (-not (Test-Path -LiteralPath $InstallDir)) {
  Write-Host '[卸载] 安装目录不存在，已跳过。' -ForegroundColor DarkYellow
  Write-Host ''
  Write-Host '[卸载] 完成。' -ForegroundColor Green
  Pause-HitKey
  exit 0
}

$dlDir = Join-Path $InstallDir 'local\downloads'
$keepDownloads = $false
if (Test-Path -LiteralPath $dlDir) {
  $files = Get-ChildItem -LiteralPath $dlDir -Recurse -File -ErrorAction SilentlyContinue
  if ($files.Count -gt 0) {
    Write-Host "检测到 $($files.Count) 个已下载的插件文件。" -ForegroundColor Yellow
    $ans = Read-Host '是否保留下载的插件文件？(y/N)'
    $keepDownloads = ($ans.Trim().ToLower() -eq 'y')
  }
}

if ($keepDownloads) {
  $localDir = Join-Path $InstallDir 'local'
  Get-ChildItem -LiteralPath $InstallDir -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne 'local' } |
    ForEach-Object { Remove-PathHard $_.FullName | Out-Null }
  if (Test-Path -LiteralPath $localDir) {
    Get-ChildItem -LiteralPath $localDir -Force -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -ne 'downloads' } |
      ForEach-Object { Remove-PathHard $_.FullName | Out-Null }
  }
} else {
  Remove-PathHard $InstallDir | Out-Null
}

if (Test-Path -LiteralPath $InstallDir) {
  Write-Host '[卸载] 部分文件仍被占用，未能完全删除。' -ForegroundColor Red
  Write-Host "  请重启电脑后删除该目录：$InstallDir" -ForegroundColor Yellow
} elseif ($keepDownloads) {
  Write-Host "[卸载] 已删除程序文件，下载文件保留在：$dlDir" -ForegroundColor Green
} else {
  Write-Host '[卸载] 已删除安装目录。' -ForegroundColor Green
}

Write-Host ''
Write-Host '[卸载] 完成。' -ForegroundColor Green
Pause-HitKey
