# ABO LAN deploy — bind Observer on all interfaces and print connection info
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$envFile = Join-Path $Root ".env"
if (-not (Test-Path $envFile)) {
  Copy-Item (Join-Path $Root ".env.example") $envFile
}

# Ensure LAN bind
$envContent = Get-Content $envFile -Raw
if ($envContent -notmatch "OBSERVER_HOST=") {
  Add-Content $envFile "`nOBSERVER_HOST=0.0.0.0"
} else {
  $envContent = $envContent -replace "OBSERVER_HOST=.*", "OBSERVER_HOST=0.0.0.0"
  Set-Content $envFile $envContent -NoNewline
}

if ($envContent -notmatch "ABO_API_TOKEN=" -or $envContent -match "ABO_API_TOKEN=\s*$") {
  $token = -join ((1..24) | ForEach-Object { Get-Random -InputObject ([char[]](48..57 + 65..90 + 97..122)) })
  if ($envContent -match "ABO_API_TOKEN=") {
    $envContent = Get-Content $envFile -Raw
    $envContent = $envContent -replace "ABO_API_TOKEN=.*", "ABO_API_TOKEN=$token"
    Set-Content $envFile $envContent -NoNewline
  } else {
    Add-Content $envFile "`nABO_API_TOKEN=$token"
  }
  Write-Host "Generated ABO_API_TOKEN=$token"
}

$ip = (
  Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.PrefixOrigin -ne "WellKnown" } |
  Select-Object -First 1 -ExpandProperty IPAddress
)
if (-not $ip) { $ip = "YOUR_LAN_IP" }

$public = "http://${ip}:3847"
$envContent = Get-Content $envFile -Raw
if ($envContent -match "OBSERVER_PUBLIC_URL=") {
  $envContent = $envContent -replace "OBSERVER_PUBLIC_URL=.*", "OBSERVER_PUBLIC_URL=$public"
  Set-Content $envFile $envContent -NoNewline
} else {
  Add-Content $envFile "`nOBSERVER_PUBLIC_URL=$public"
}

$tokenLine = (Get-Content $envFile | Where-Object { $_ -match "^ABO_API_TOKEN=" } | Select-Object -First 1)
$tokenVal = if ($tokenLine) { $tokenLine.Substring("ABO_API_TOKEN=".Length) } else { "" }

Write-Host ""
Write-Host "=== ABO LAN Deploy ===" -ForegroundColor Cyan
Write-Host "Public URL : $public"
Write-Host "API token  : $tokenVal"
Write-Host ""
Write-Host "Building extension with this URL baked in..."
$env:ABO_DEFAULT_OBSERVER_URL = $public
$env:ABO_DEFAULT_API_TOKEN = $tokenVal
npm run build:extension

Write-Host ""
Write-Host "Starting Observer (Ctrl+C to stop)..."
Write-Host "Users: Load unpacked -> extension\dist , Options URL=$public"
Write-Host "Open firewall for TCP 3847 if other PCs cannot connect."
Write-Host ""

Set-Location (Join-Path $Root "observer")
npm start
