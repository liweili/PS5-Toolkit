#Requires -Version 5.1
<#
.SYNOPSIS
  把本地中文站点（local/site）打包成 GitHub Pages 静态站点（docs/）。
.DESCRIPTION
  输出到 docs/，GitHub Pages 源设置为 main 分支 /docs 目录。
  数据文件取自 local/site/data/repos-database.json（由本地服务生成，含中文描述）。
  每次更新数据后重新执行本脚本，并提交 docs/ 即可刷新线上数据。
#>
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Src      = Join-Path $RepoRoot 'local\site'
$Out      = Join-Path $RepoRoot 'docs'
$DataSrc  = Join-Path $Src 'data\repos-database.json'

if (-not (Test-Path $DataSrc)) { throw "数据文件不存在: $DataSrc" }

New-Item -ItemType Directory -Path (Join-Path $Out 'data') -Force | Out-Null

Copy-Item (Join-Path $Src 'index.html') $Out -Force
Copy-Item (Join-Path $Src 'app.js')     $Out -Force
Copy-Item (Join-Path $Src 'styles.css') $Out -Force
Copy-Item $DataSrc (Join-Path $Out 'data\repos-database.json') -Force
New-Item -ItemType File -Path (Join-Path $Out '.nojekyll') -Force | Out-Null

$size = (Get-Item (Join-Path $Out 'data\repos-database.json')).Length / 1KB
Write-Host ("已生成 docs/ ：数据文件 {0:N0} KB" -f $size) -ForegroundColor Green
