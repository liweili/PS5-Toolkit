#Requires -Version 5.1
<#
.SYNOPSIS
  构建 PS5 插件更新中心的分发包（zip），供发布到 GitHub Release。
.DESCRIPTION
  将运行所需的应用文件复制到 dist/app/，与 install.ps1 / start.bat / uninstall.ps1
  一起打包成 PS5-Plugin-Hub.zip。用户解压后右键 install.ps1 即可安装。
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
$AppDir   = Join-Path $DistDir 'app'
$ZipPath  = Join-Path $ReleaseDir 'PS5-Plugin-Hub.zip'

Write-Host "仓库根目录: $RepoRoot"
Write-Host "安装器目录: $ScriptDir"
Write-Host "产物目录:   $ReleaseDir"

# 清理旧产物
if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force }
if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
if (-not (Test-Path $ReleaseDir)) { New-Item -ItemType Directory -Path $ReleaseDir -Force | Out-Null }
New-Item -ItemType Directory -Path $AppDir -Force | Out-Null

# ---------- 复制应用文件 ----------
function Copy-Needed($src, $dst) {
  if (-not (Test-Path $src)) { Write-Warning "源不存在，跳过: $src"; return }
  $parent = Split-Path $dst
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  $item = Get-Item $src
  if ($item.PSIsContainer) {
    # 目录：先删目标再复制，避免 PowerShell -Recurse 嵌套复制
    if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
    Copy-Item $src $dst -Recurse -Force
  } else {
    Copy-Item $src $dst -Force
  }
}

# 1. 上游数据（同步的基准文件）
Copy-Needed (Join-Path $RepoRoot 'json\repos-database.json') (Join-Path $AppDir 'json\repos-database.json')

# 2. 本地应用核心
Copy-Needed (Join-Path $RepoRoot 'local\scripts')        (Join-Path $AppDir 'local\scripts')
Copy-Needed (Join-Path $RepoRoot 'local\site')           (Join-Path $AppDir 'local\site')
Copy-Needed (Join-Path $RepoRoot 'local\i18n')           (Join-Path $AppDir 'local\i18n')
Copy-Needed (Join-Path $RepoRoot 'local\config.json')    (Join-Path $AppDir 'local\config.json')
Copy-Needed (Join-Path $RepoRoot 'local\start.ps1')      (Join-Path $AppDir 'local\start.ps1')
Copy-Needed (Join-Path $RepoRoot 'local\run-daily.ps1')  (Join-Path $AppDir 'local\run-daily.ps1')

# 3. 运行时目录（空骨架，首次启动时生成）
foreach ($d in @('downloads', 'logs', 'state')) {
  New-Item -ItemType Directory -Path (Join-Path $AppDir "local\$d") -Force | Out-Null
}

# ---------- 打包 ----------
Write-Host '正在压缩分发包...'
Compress-Archive -Path (Join-Path $AppDir '*'), (Join-Path $ScriptDir 'install.ps1'), (Join-Path $ScriptDir 'start.bat'), (Join-Path $ScriptDir 'uninstall.ps1') -DestinationPath $ZipPath -Force

$size = (Get-Item $ZipPath).Length / 1MB

# 清理暂存目录
Remove-Item $AppDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host "构建完成: $ZipPath" -ForegroundColor Green
Write-Host ("大小: {0:N1} MB" -f $size) -ForegroundColor Green
Write-Host ''
Write-Host '发布步骤:' -ForegroundColor Cyan
Write-Host '  1. 在 GitHub 仓库创建 Release'
Write-Host "  2. 上传 $ZipPath 作为 Release 资产"
Write-Host '  3. 用户下载解压后，右键 install.ps1 -> 使用 PowerShell 运行'
