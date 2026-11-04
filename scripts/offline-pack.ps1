$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName 'System.IO.Compression'
Add-Type -AssemblyName 'System.IO.Compression.FileSystem'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  'AMD64' { 'win-x64' }
  'ARM64' { 'win-arm64' }
  default { throw 'Requires Windows x64 or ARM64' }
}
$version = 'v22.16.0'
$runtime = Join-Path $root '.runtime'
$nodeDir = Join-Path $runtime ('node-' + $arch)
$nodeExe = Join-Path $nodeDir 'node.exe'
$modules = Join-Path $root 'node_modules'
$marker = Join-Path $runtime 'dependency-architecture.txt'
$pkg = if (Test-Path -LiteralPath (Join-Path $root 'package-lock.json')) {
  Join-Path $root 'package-lock.json'
} else { Join-Path $root 'package.json' }
$expected = $arch + '|' + $version + '|' + (Get-FileHash -LiteralPath $pkg -Algorithm SHA256).Hash
if (-not (Test-Path -LiteralPath $nodeExe) -or
    -not (Test-Path -LiteralPath $modules) -or
    -not (Test-Path -LiteralPath $marker) -or
    (Get-Content -LiteralPath $marker -Raw).Trim() -ne $expected) {
  throw 'Run TENSEI.bat successfully once while online before making an offline package.'
}
& $nodeExe -e "for (const x of ['sharp','bmp-js','exceljs','jszip']) require(x)"
if ($LASTEXITCODE -ne 0) { throw 'Dependencies are not healthy; rerun TENSEI.bat before creating offline package.' }
$backupDir = Join-Path $root 'backups'
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
$output = Join-Path $backupDir ('TENSEI_offline_' + $arch + '_' +
  (Get-Date -Format 'yyyyMMdd_HHmmss') + '.zip')
$excluded = @('.git','data','reports','backups','.rapidocr-venv','.runtime','node_modules')
$zip = [System.IO.Compression.ZipFile]::Open($output,
  [System.IO.Compression.ZipArchiveMode]::Create)
$total = [long]0
try {
  function Add-File {
    param([string]$file,[string]$entry)
    $entry = $entry.Replace('\','/')
    $info = Get-Item -LiteralPath $file
    $script:total += $info.Length
    if ($script:total -gt 3GB) { throw 'Portable package exceeds 3 GB; inspect installed dependencies.' }
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$file,$entry,
      [System.IO.Compression.CompressionLevel]::Fastest) | Out-Null
  }
  foreach ($entry in Get-ChildItem -LiteralPath $root -Force) {
    if ($excluded -contains $entry.Name -or
        $entry.Name -eq '.env' -or $entry.Name -like 'TENSEI_backup_*.zip') { continue }
    if ($entry.PSIsContainer) {
      foreach ($file in Get-ChildItem -LiteralPath $entry.FullName -File -Recurse -Force) {
        if ($file.FullName -match '(__pycache__|\.pytest_cache)') { continue }
        Add-File $file.FullName $file.FullName.Substring($root.Length+1)
      }
    } else {
      Add-File $entry.FullName $entry.Name
    }
  }
  foreach ($directory in @($nodeDir,$modules)) {
    foreach ($file in Get-ChildItem -LiteralPath $directory -File -Recurse -Force) {
      Add-File $file.FullName $file.FullName.Substring($root.Length+1)
    }
  }
  Add-File $marker $marker.Substring($root.Length+1)
} catch {
  $zip.Dispose()
  Remove-Item -LiteralPath $output -Force -ErrorAction SilentlyContinue
  throw
} finally { $zip.Dispose() }
Write-Host "Offline portable package created: $output"
Write-Host "Target CPU architecture MUST be $arch. Does not include data, reports, or API keys."
Write-Host 'Use TENSEI_Backup.bat separately for your private user data.'
