#Requires -Version 5.1
<#
.SYNOPSIS
  PS5 插件更新中心 - 卸载脚本
#>
$ErrorActionPreference = 'Stop'

$AppName    = 'PS5 插件更新中心'
$AppDirName = 'PS5-Plugin-Hub'
$InstallDir = $PSScriptRoot

function Pause-HitKey {
  Write-Host '按任意键继续...' -ForegroundColor Cyan
  $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
}

Write-Host ''
Write-Host '========================================' -ForegroundColor Cyan
Write-Host "  卸载 $AppName" -ForegroundColor Cyan
Write-Host '========================================' -ForegroundColor Cyan
Write-Host ''

# 停止服务进程
Write-Host '[卸载] 正在停止服务...' -ForegroundColor Cyan
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
  if ($_.CommandLine -like '*PS5-Plugin-Hub*' -or $_.CommandLine -like '*server.js*') {
    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
  }
}

# 删除快捷方式
$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) $AppName
Remove-Item (Join-Path $desktop "$AppName.lnk") -ErrorAction SilentlyContinue
Remove-Item $startMenu -Recurse -Force -ErrorAction SilentlyContinue

# 删除安装目录（保留用户下载文件可选）
if (Test-Path $InstallDir) {
  $dlDir = Join-Path $InstallDir 'local\downloads'
  $keepDownloads = $false
  if (Test-Path $dlDir) {
    $files = Get-ChildItem $dlDir -Recurse -File -ErrorAction SilentlyContinue
    if ($files.Count -gt 0) {
      Write-Host "检测到 $($files.Count) 个已下载的插件文件。" -ForegroundColor Yellow
      $ans = Read-Host '是否保留下载的插件文件？(y/N)'
      $keepDownloads = ($ans.Trim().ToLower() -eq 'y')
    }
  }
  if ($keepDownloads) {
    # 只保留 downloads，其余删除
    Get-ChildItem $InstallDir -Force | Where-Object { $_.Name -ne 'local' } | Remove-Item -Recurse -Force
    $localDir = Join-Path $InstallDir 'local'
    Get-ChildItem $localDir -Force | Where-Object { $_.Name -ne 'downloads' } | Remove-Item -Recurse -Force
    Write-Host "[卸载] 已删除程序文件，下载文件保留在: $dlDir" -ForegroundColor Green
  } else {
    Remove-Item $InstallDir -Recurse -Force
    Write-Host '[卸载] 已删除安装目录。' -ForegroundColor Green
  }
} else {
  Write-Host '[卸载] 安装目录不存在，已跳过。' -ForegroundColor DarkYellow
}

Write-Host ''
Write-Host '[卸载] 完成。' -ForegroundColor Green
Pause-HitKey
