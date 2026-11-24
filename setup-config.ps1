# First-run setup: asks for the user's own callsign and writes config.json.
# Called by start.cmd only when config.json does not exist yet.
$ErrorActionPreference = 'Stop'
$configPath = Join-Path $PSScriptRoot 'config.json'

Write-Host ''
Write-Host 'First-time setup'
Write-Host '----------------'
Write-Host 'The YSF tab can listen (listen-only, it never transmits) to the busiest YSF reflectors'
Write-Host 'to count real activity. That needs YOUR OWN amateur callsign to identify itself.'
Write-Host 'Press Enter to skip; the YSF tab then ranks by connected users only.'
Write-Host 'You can change this later in config.json.'
Write-Host ''

$call = ''
try {
    $raw = Read-Host 'Your callsign'
    $call = ($raw.ToUpper() -replace '[^A-Z0-9]', '')
} catch { $call = '' }

# Basic shape check: 3-10 characters with at least one letter and one digit.
if ($call -and -not ($call.Length -ge 3 -and $call.Length -le 10 -and $call -match '[A-Z]' -and $call -match '[0-9]')) {
    Write-Host "'$call' doesn't look like a callsign, so the YSF listener will stay off."
    $call = ''
}

$config = [ordered]@{ callsign = $call; listenTop = 50 }
($config | ConvertTo-Json) | Set-Content -Path $configPath -Encoding ascii

if ($call) { Write-Host "Saved. The YSF listener will identify as $call." }
else { Write-Host 'Saved with no callsign: the YSF listener is off.' }
Write-Host ''
