param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateNotNullOrEmpty()]
    [string]$ScriptName,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ScriptArgs = @()
)

$ErrorActionPreference = "Stop"

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$nodeVersion = (Get-Content -LiteralPath (Join-Path $root ".nvmrc") -Raw).Trim()
$nodeDirectory = Join-Path $root ".tools\node-v$nodeVersion-win-x64"
$npmExecutable = Join-Path $nodeDirectory "npm.cmd"

if (-not (Test-Path -LiteralPath $npmExecutable)) {
    throw "Pinned Node is missing. Run scripts\bootstrap.ps1 first."
}

$env:PATH = "$nodeDirectory;$env:PATH"
if ($ScriptArgs.Count -gt 0) {
    & $npmExecutable run $ScriptName -- @ScriptArgs
} else {
    & $npmExecutable run $ScriptName
}
exit $LASTEXITCODE
