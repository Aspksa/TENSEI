$ErrorActionPreference = 'Stop'
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('tensei-bootstrap-' + [guid]::NewGuid().ToString('N'))
$source = Join-Path $temporary 'source'
$target = Join-Path $temporary 'offline'
try {
  New-Item -ItemType Directory -Path (Join-Path $source 'scripts') -Force | Out-Null
  foreach ($file in @('package.json','package-lock.json','TENSEI.bat')) {
    Copy-Item -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) $file) -Destination (Join-Path $source $file)
  }
  foreach ($file in @('launch.ps1','offline-pack.ps1')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $source 'scripts' $file)
  }
  Write-Host 'Cold install in isolated temporary folder:'
  & (Join-Path $source 'scripts\launch.ps1') -InstallOnly
  if ($LASTEXITCODE -ne 0) { throw 'Cold portable bootstrap failed.' }
  $marker = Join-Path $source '.runtime\dependency-architecture.txt'
  if (-not (Test-Path -LiteralPath $marker)) { throw 'Dependency marker missing after cold bootstrap.' }
  Write-Host 'Create architecture-specific offline archive:'
  & (Join-Path $source 'scripts\offline-pack.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'Offline bundle creation failed.' }
  $archive = Get-ChildItem -LiteralPath (Join-Path $source 'backups') -Filter 'TENSEI_offline_*.zip' |
    Select-Object -First 1
  if (-not $archive) { throw 'Offline archive was not produced.' }
  New-Item -ItemType Directory -Path $target -Force | Out-Null
  Expand-Archive -LiteralPath $archive.FullName -DestinationPath $target
  if (-not (Test-Path -LiteralPath (Join-Path $target 'scripts\launch.ps1'))) {
    throw 'Offline archive does not include launcher.'
  }
  Write-Host 'Verify extracted offline installation without a dependency reinstall:'
  & (Join-Path $target 'scripts\launch.ps1') -InstallOnly
  if ($LASTEXITCODE -ne 0) { throw 'Offline installation failed.' }
  if (-not (Test-Path -LiteralPath (Join-Path $target '.runtime\dependency-architecture.txt'))) {
    throw 'Offline dependency marker missing.'
  }
  Write-Host 'TENSEI_BOOTSTRAP_TEST_OK'
} finally {
  Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
exit 0
