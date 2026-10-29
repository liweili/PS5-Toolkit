$ErrorActionPreference = 'SilentlyContinue'

$local = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $local
$script = Join-Path $local 'scripts\sync.js'
$logDir = Join-Path $local 'logs'
$log = Join-Path $logDir 'daily-task.log'

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { exit 1 }

$out = & $nodeCmd.Source --use-system-ca $script 2>&1
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Add-Content -Path $log -Value ("[" + $stamp + "]`r`n" + ($out -join "`r`n") + "`r`n") -Encoding UTF8

# 每日同步金手指仓库（HEN Cheats Collection）
# 浅克隆仓库不能 pull，改用 fetch + reset --hard 对齐远端最新提交；
# 版本历史会在服务端下次被访问时自动重新解析。
$cheatsDir = Join-Path $local 'cheats\HEN-Cheats-Collection'
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if ($gitCmd -and (Test-Path (Join-Path $cheatsDir '.git'))) {
  $gout = & $gitCmd.Source -C $cheatsDir fetch --depth 1 origin HEAD 2>&1
  $rout = & $gitCmd.Source -C $cheatsDir reset --hard FETCH_HEAD 2>&1
  $gstamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path $log -Value ("[" + $gstamp + "] 金手指同步`r`n" + (($gout + $rout) -join "`r`n") + "`r`n") -Encoding UTF8
}

# 每日快速同步 PS4/PS5 游戏资源（仅首页几页，抓取当日新增）
$gamesScript = Join-Path $local 'scripts\sync-games.js'
if (Test-Path $gamesScript) {
  $gamesOut = & $nodeCmd.Source --use-system-ca $gamesScript --quick 2>&1
  $gamesStamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path $log -Value ("[" + $gamesStamp + "] 游戏资源快速同步`r`n" + ($gamesOut -join "`r`n") + "`r`n") -Encoding UTF8
}
