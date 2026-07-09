param(
    [Parameter(Position = 0)]
    [ValidateNotNullOrEmpty()]
    [string]$ScriptName = "verify",

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ScriptArgs = @()
)

$ErrorActionPreference = "Stop"

$runner = Join-Path $PSScriptRoot "npm-pinned.ps1"
& $runner $ScriptName @ScriptArgs
exit $LASTEXITCODE
