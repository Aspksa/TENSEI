param(
  [ValidateSet('Backup','Restore')][string]$Mode = 'Backup',
  [string]$Archive = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName 'System.IO.Compression'
Add-Type -AssemblyName 'System.IO.Compression.FileSystem'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path

function Export-Backup {
  $backupDir = Join-Path $root 'backups'
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
  $name = 'TENSEI_backup_' + (Get-Date -Format 'yyyyMMdd_HHmmss') + '_' +
    [guid]::NewGuid().ToString('N').Substring(0,8) + '.zip'
  $destination = Join-Path $backupDir $name
  $manifest = @()
  $zip = [System.IO.Compression.ZipFile]::Open($destination,
    [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($folder in @('data','reports')) {
      $directory = Join-Path $root $folder
      if (-not (Test-Path -LiteralPath $directory -PathType Container)) { continue }
      $items = @(Get-ChildItem -LiteralPath $directory -File -Recurse -Force)
      foreach ($file in $items) {
        $relative = $file.FullName.Substring($root.Length + 1).Replace('\','/')
        if ($file.Length -gt 2GB) {
          throw "File too large for portable backup: $relative"
        }
        $digest = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,
          $file.FullName,$relative,[System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        $manifest += @{ path=$relative; sha256=$digest; size=[long]$file.Length }
      }
    }
    $item = $zip.CreateEntry('manifest.json')
    $writer = New-Object System.IO.StreamWriter($item.Open(), [Text.Encoding]::UTF8)
    try {
      $writer.Write((@{ format='tensei-transfer-v1'; at=(Get-Date).ToUniversalTime().ToString('o');
        files=@($manifest) } | ConvertTo-Json -Depth 6))
    } finally { $writer.Dispose() }
  } catch {
    $zip.Dispose()
    Remove-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue
    throw
  } finally { $zip.Dispose() }
  Write-Host "Backup ready: $destination"
  Write-Host 'Contains personal data and possibly Cloud.ru API key. Keep archive private.'
  Write-Host 'Copy this ZIP to the new computer; restore only after closing TENSEI.'
}

function Import-Backup {
  if (-not $Archive) { $Archive = Read-Host 'Enter the full path to TENSEI backup ZIP' }
  if (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) {
    throw "Backup archive not found: $Archive"
  }
  $archivePath = (Resolve-Path -LiteralPath $Archive).Path
  foreach ($dir in @('data','reports')) {
    $target = Join-Path $root $dir
    if ((Test-Path -LiteralPath $target) -and
        @(Get-ChildItem -LiteralPath $target -Force).Count -gt 0) {
      throw "Refusing to overwrite existing $dir files. Move the existing folder to a separate backup location first."
    }
  }
  $stage = Join-Path $root ('.tensei-restore-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  $zip = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
  $moved = @()
  try {
    $manifestEntry = $zip.GetEntry('manifest.json')
    if ($null -eq $manifestEntry) { throw 'Not a supported TENSEI backup: manifest.json missing.' }
    $reader = New-Object System.IO.StreamReader($manifestEntry.Open())
    try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json }
    finally { $reader.Dispose() }
    if ($manifest.format -ne 'tensei-transfer-v1') { throw 'Unsupported backup format.' }
    $expected = @{}
    foreach ($item in @($manifest.files)) {
      $relative = [string]$item.path
      if ($relative -notmatch '^(data|reports)/' -or
          $relative -match '(^|/)\.\.?(/|$)' -or
          $relative.Contains('\') -or $expected.ContainsKey($relative)) {
        throw "Unsafe or duplicate manifest path: $relative"
      }
      $expected[$relative] = $item
    }
    $actual = @{}
    $total = [long]0
    foreach ($entry in $zip.Entries) {
      if ($entry.FullName -eq 'manifest.json') { continue }
      $relative = $entry.FullName
      if (-not $expected.ContainsKey($relative) -or
          $actual.ContainsKey($relative) -or
          $relative -match '(^|/)\.\.?(/|$)' -or
          $relative.Contains('\') -or $entry.Name.Length -eq 0) {
        throw "Untrusted backup file: $relative"
      }
      $total += [long]$entry.Length
      if ($total -gt 8GB) { throw 'Backup exceeds the 8 GB restore safety limit.' }
      $destination = Join-Path $stage ($relative.Replace('/',[IO.Path]::DirectorySeparatorChar))
      New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
      $stream = [IO.File]::Open($destination,[IO.FileMode]::CreateNew)
      try {
        $inputStream = $entry.Open()
        try { $inputStream.CopyTo($stream) }
        finally { $inputStream.Dispose() }
      } finally { $stream.Dispose() }
      if ((Get-Item -LiteralPath $destination).Length -ne [long]$expected[$relative].size -or
        (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne
          [string]$expected[$relative].sha256) {
        throw "Backup checksum mismatch: $relative"
      }
      $actual[$relative] = $true
    }
    if ($actual.Count -ne $expected.Count) { throw 'Backup files do not match manifest.' }
    foreach ($folder in @('data','reports')) {
      $source = Join-Path $stage $folder
      if (-not (Test-Path -LiteralPath $source)) { continue }
      $target = Join-Path $root $folder
      if (Test-Path -LiteralPath $target) {
        Remove-Item -LiteralPath $target -Force
      }
      Move-Item -LiteralPath $source -Destination $target
      $moved += $folder
    }
    Write-Host 'Backup restored. Review Cloud.ru API key and source records on this computer.'
  } catch {
    foreach ($folder in $moved) {
      $target = Join-Path $root $folder
      $back = Join-Path $stage $folder
      if (Test-Path -LiteralPath $target) {
        Move-Item -LiteralPath $target -Destination $back
      }
    }
    throw
  } finally {
    $zip.Dispose()
    Remove-Item -LiteralPath $stage -Force -Recurse -ErrorAction SilentlyContinue
  }
}
try {
  if ($Mode -eq 'Backup') { Export-Backup }
  else { Import-Backup }
} catch {
  Write-Host ('Transfer error: ' + $_.Exception.Message) -ForegroundColor Red
  exit 1
}
