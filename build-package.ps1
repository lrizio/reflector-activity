# Builds the distributable zips into .\dist
#   ReflectorActivity-<version>-windows.zip  : app + bundled Node.js (nothing to install)
#   ReflectorActivity-<version>-source.zip   : app only (needs Node.js 24+; Windows, Mac or Linux)
# Never copies: data\ (history, logs), config.json (your callsign), .git, dist\.
#
# Usage:  powershell -ExecutionPolicy Bypass -File .\build-package.ps1
param([string]$NodeExe = (Get-Command node).Source)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$dist = Join-Path $PSScriptRoot 'dist'
$files = @('server.mjs', 'package.json', 'package-lock.json', 'start.cmd', 'start.sh', 'setup-config.ps1', 'README.txt', 'LICENSE')

function New-Stage([string]$name, [bool]$withNode) {
    $stage = Join-Path $dist $name
    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
    New-Item -ItemType Directory -Path $stage | Out-Null
    foreach ($f in $files) { Copy-Item (Join-Path $PSScriptRoot $f) $stage }
    Copy-Item (Join-Path $PSScriptRoot 'public') (Join-Path $stage 'public') -Recurse
    # start.sh needs Unix line endings to run on Mac/Linux
    $sh = Join-Path $stage 'start.sh'
    [IO.File]::WriteAllText($sh, ([IO.File]::ReadAllText($sh) -replace "`r`n", "`n"))
    Push-Location $stage
    try { npm ci --omit=dev --no-audit --no-fund | Out-Null; if ($LASTEXITCODE) { throw 'npm ci failed' } } finally { Pop-Location }
    if ($withNode) {
        # Node.js is MIT-licensed; redistributing node.exe requires shipping its licence text.
        # The licence must match the bundled version: licenses\NODE-LICENSE-<version>.txt
        $nodeLicense = Join-Path $PSScriptRoot "licenses\NODE-LICENSE-$nodeVersion.txt"
        if (-not (Test-Path $nodeLicense)) {
            throw "Missing $nodeLicense. Save https://raw.githubusercontent.com/nodejs/node/$nodeVersion/LICENSE there, then rebuild."
        }
        New-Item -ItemType Directory -Path (Join-Path $stage 'runtime') | Out-Null
        Copy-Item $NodeExe (Join-Path $stage 'runtime\node.exe')
        Copy-Item $nodeLicense (Join-Path $stage 'runtime\LICENSE-node.txt')
    }
    return $stage
}

function Compress-Stage([string]$stage, [string]$zip) {
    if (Test-Path $zip) { Remove-Item $zip -Force }
    # zip the folder itself so it unpacks into one tidy directory
    Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal
    $mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
    $hash = (Get-FileHash $zip -Algorithm SHA256).Hash
    "{0}  {1} MB`n  SHA256 {2}" -f (Split-Path $zip -Leaf), $mb, $hash
}

if (-not (Test-Path $dist)) { New-Item -ItemType Directory -Path $dist | Out-Null }
$nodeVersion = (& $NodeExe --version).Trim()
Write-Host "Using Node $nodeVersion from $NodeExe"

$win = New-Stage "ReflectorActivity-$version" $true
Compress-Stage $win (Join-Path $dist "ReflectorActivity-$version-windows.zip")

$src = New-Stage "ReflectorActivity-$version-source" $false
Compress-Stage $src (Join-Path $dist "ReflectorActivity-$version-source.zip")

# staging folders are no longer needed
Remove-Item $win, $src -Recurse -Force
