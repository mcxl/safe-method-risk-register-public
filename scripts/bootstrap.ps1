$ErrorActionPreference = "Stop"

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$nodeVersion = "24.18.0"
$nodeArchiveName = "node-v$nodeVersion-win-x64.zip"
$nodeDirectory = Join-Path $root ".tools\node-v$nodeVersion-win-x64"
$toolsDirectory = Join-Path $root ".tools"
$archivePath = Join-Path $toolsDirectory $nodeArchiveName

New-Item -ItemType Directory -Force -Path $toolsDirectory | Out-Null

if (-not (Test-Path -LiteralPath $nodeDirectory)) {
    $baseUrl = "https://nodejs.org/dist/v$nodeVersion"
    Invoke-WebRequest -Uri "$baseUrl/$nodeArchiveName" -OutFile $archivePath
    $checksums = Invoke-RestMethod -Uri "$baseUrl/SHASUMS256.txt"
    $expected = (($checksums -split "`n") |
        Where-Object { $_ -match "\s+$([regex]::Escape($nodeArchiveName))$" } |
        Select-Object -First 1).Split()[0].ToUpperInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash

    if (-not $expected -or $actual -ne $expected) {
        throw "Node archive checksum verification failed."
    }

    Expand-Archive -LiteralPath $archivePath -DestinationPath $toolsDirectory
}

$nodeExecutable = Join-Path $nodeDirectory "node.exe"
$npmExecutable = Join-Path $nodeDirectory "npm.cmd"
if (-not (Test-Path -LiteralPath $nodeExecutable)) {
    throw "Pinned Node executable was not installed at $nodeExecutable"
}

$venvPython = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $venvPython)) {
    & py -3.13 -m venv (Join-Path $root ".venv")
}

& $venvPython -m pip install --requirement (Join-Path $root "requirements.txt")

$env:PATH = "$nodeDirectory;$env:PATH"
if (Test-Path -LiteralPath (Join-Path $root "package-lock.json")) {
    & $npmExecutable ci
}

Write-Host "Bootstrap complete."
Write-Host "Node: $(& $nodeExecutable --version)"
Write-Host "Python: $(& $venvPython --version)"
