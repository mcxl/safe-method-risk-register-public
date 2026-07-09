param(
  [Parameter(Mandatory = $true)]
  [string]$WorkbookPath
)

$ErrorActionPreference = "Stop"
$excel = $null
$workbook = $null

try {
  $resolved = Resolve-Path -LiteralPath $WorkbookPath
  $excel = New-Object -ComObject Excel.Application
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $workbook = $excel.Workbooks.Open($resolved.Path)
  $excel.CalculateFullRebuild()
  $workbook.Save()
  Write-Output "PASS Excel CalculateFullRebuild saved $($resolved.Path)"
} finally {
  if ($workbook -ne $null) {
    $workbook.Close($true) | Out-Null
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($workbook) | Out-Null
  }
  if ($excel -ne $null) {
    $excel.Quit()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
