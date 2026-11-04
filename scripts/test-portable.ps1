$ErrorActionPreference = 'Stop'
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('tensei-portable-test-' + [guid]::NewGuid().ToString('N'))
try {
  $old = Join-Path $temporary 'old'
  $new = Join-Path $temporary 'new'
  foreach ($x in @($old,$new)) {
    New-Item -ItemType Directory -Path (Join-Path $x 'scripts') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'transfer.ps1') -Destination (Join-Path $x 'scripts\transfer.ps1')
  }
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'launch.ps1') -Destination (Join-Path $old 'scripts\launch.ps1')
  New-Item -ItemType Directory -Path (Join-Path $old 'data') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $old 'reports\Легион') -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $old 'data\draft.json') -Value '{"rows":[{"vehicle":"А123ВС"}]}' -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $old 'reports\Легион\report.txt') -Value 'private sample' -Encoding UTF8
  & (Join-Path $old 'scripts\launch.ps1') -PreflightOnly
  if ($LASTEXITCODE -ne 0) { throw 'Preflight failed' }
  & (Join-Path $old 'scripts\transfer.ps1') -Mode Backup
  if ($LASTEXITCODE -ne 0) { throw 'Backup failed' }
  $backup = Get-ChildItem -LiteralPath (Join-Path $old 'backups') -Filter '*.zip' | Select-Object -First 1
  if (-not $backup) { throw 'No backup was created' }
  & (Join-Path $new 'scripts\transfer.ps1') -Mode Restore -Archive $backup.FullName
  if ($LASTEXITCODE -ne 0) { throw 'Restore failed' }
  $draft = Get-Content -LiteralPath (Join-Path $new 'data\draft.json') -Raw
  if ($draft -notmatch 'А123ВС') { throw 'Draft not restored correctly' }
  $report = Get-Content -LiteralPath (Join-Path $new 'reports\Легион\report.txt') -Raw
  if ($report -notmatch 'private sample') { throw 'Report not restored correctly' }
  $original = (Get-FileHash -LiteralPath (Join-Path $new 'data\draft.json') -Algorithm SHA256).Hash
  & (Join-Path $new 'scripts\transfer.ps1') -Mode Restore -Archive $backup.FullName
  if ($LASTEXITCODE -eq 0) { throw 'Restore wrongly overwrote existing data' }
  if ($original -ne (Get-FileHash -LiteralPath (Join-Path $new 'data\draft.json') -Algorithm SHA256).Hash) {
    throw 'Overwrite guard modified user data'
  }
  Write-Host 'TENSEI_PORTABLE_TEST_OK'
} finally {
  Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
