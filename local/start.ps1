$ErrorActionPreference = 'SilentlyContinue'

$local = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $local
$port = 8123
$url = "http://127.0.0.1:$port/?today=1"
$serverScript = Join-Path $local 'scripts\server.js'

function Test-Server {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/ping" -UseBasicParsing -TimeoutSec 2
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
}

if (-not (Test-Server)) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show('Node.js was not found. Please install Node.js 18 or newer, then try again.', 'PS5 Plugin Update Center') | Out-Null
    exit 1
  }
  Start-Process -FilePath $nodeCmd.Source -ArgumentList @('--use-system-ca', "`"$serverScript`"") -WorkingDirectory $root -WindowStyle Hidden
  for ($i = 0; $i -lt 50; $i++) {
    Start-Sleep -Milliseconds 300
    if (Test-Server) { break }
  }
}

if (Test-Server) {
  Start-Process $url
} else {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show('The local service failed to start. Run local\scripts\server.js manually to see the error.', 'PS5 Plugin Update Center') | Out-Null
}
