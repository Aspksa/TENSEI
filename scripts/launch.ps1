param([switch]$PreflightOnly)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $root
$runtime = Join-Path $root '.runtime'
$version = 'v22.16.0'
$nodeBase = 'https://nodejs.org/dist/' + $version
$minimumFreeBytes = 650MB
$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  'AMD64' { 'win-x64' }
  'ARM64' { 'win-arm64' }
  default { throw "Requires Windows 10/11 64-bit AMD64/ARM64. Found: $env:PROCESSOR_ARCHITECTURE" }
}
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
    [Environment]::OSVersion.Version.Major -lt 10) {
  throw 'Requires Windows 10 or 11 (64-bit).'
}
function Test-WriteAccess {
  param([string]$Directory)
  $probe = Join-Path $Directory ('.tensei-write-' + [guid]::NewGuid().ToString('N'))
  try {
    [IO.File]::WriteAllText($probe, 'TENSEI write probe')
  } catch {
    throw "Cannot write to $Directory. Extract TENSEI to a user-writable folder such as D:\TENSEI (do not use Program Files)."
  } finally {
    Remove-Item -LiteralPath $probe -ErrorAction SilentlyContinue
  }
}
function Test-FreeSpace {
  param([string]$Directory)
  try {
    $driveRoot = [IO.Path]::GetPathRoot($Directory)
    $drive = New-Object System.IO.DriveInfo($driveRoot)
    if ($drive.IsReady -and $drive.AvailableFreeSpace -lt $minimumFreeBytes) {
      throw 'Less than 650 MB free. Free space on the TENSEI drive before installation.'
    }
  } catch {
    if ($_.Exception.Message -like 'Less than*') { throw }
    Write-Warning ('Cannot calculate drive free space: ' + $_.Exception.Message)
  }
}
function Assert-Node {
  param([string]$Executable,[string]$NpmFile)
  if (-not (Test-Path -LiteralPath $Executable -PathType Leaf) -or
      -not (Test-Path -LiteralPath $NpmFile -PathType Leaf)) { return $false }
  & $Executable --version 2>$null | Out-Null
  return $LASTEXITCODE -eq 0 -and ((& $Executable --version) -eq $version)
}
function Invoke-NodeDownload {
  param([string]$NodeDir)
  $fileName = "node-$version-$arch.zip"
  $stage = Join-Path $runtime ('node-stage-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  try {
    $archive = Join-Path $stage $fileName
    $checksums = Join-Path $stage 'SHASUMS256.txt'
    Write-Host 'Downloading official portable Node.js...'
    Invoke-WebRequest -Uri "$nodeBase/$fileName" -OutFile $archive -UseBasicParsing -TimeoutSec 120
    Invoke-WebRequest -Uri "$nodeBase/SHASUMS256.txt" -OutFile $checksums -UseBasicParsing -TimeoutSec 120
    $line = Get-Content -LiteralPath $checksums | Where-Object {
      $_ -match ('\s' + [regex]::Escape($fileName) + '$')
    } | Select-Object -First 1
    if (-not $line) { throw 'Node.js archive checksum not found.' }
    $expected = ($line.Trim() -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expected -ne $actual) { throw 'Node.js SHA256 checksum mismatch. Aborting.' }
    Expand-Archive -LiteralPath $archive -DestinationPath $stage -Force
    $extracted = Join-Path $stage ("node-$version-$arch")
    $verifyNode = Join-Path $extracted 'node.exe'
    $verifyNpm = Join-Path $extracted 'node_modules\npm\bin\npm-cli.js'
    if (-not (Assert-Node $verifyNode $verifyNpm)) {
      throw 'Downloaded Node.js failed version or npm verification.'
    }
    if (Test-Path -LiteralPath $NodeDir) {
      $damaged = Join-Path $runtime ('node-damaged-' + [guid]::NewGuid().ToString('N'))
      Move-Item -LiteralPath $NodeDir -Destination $damaged
      try {
        Move-Item -LiteralPath $extracted -Destination $NodeDir
        Remove-Item -LiteralPath $damaged -Recurse -Force
      } catch {
        if (-not (Test-Path -LiteralPath $NodeDir)) {
          Move-Item -LiteralPath $damaged -Destination $NodeDir
        }
        throw
      }
    } else {
      Move-Item -LiteralPath $extracted -Destination $NodeDir
    }
  } finally {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  }
}
function Assert-Dependencies {
  param([string]$Executable)
  & $Executable -e "for (const x of ['sharp','bmp-js','exceljs','jszip']) require(x);"
  return $LASTEXITCODE -eq 0
}
function Install-Dependencies {
  param([string]$Executable,[string]$NpmFile,[string]$Marker,[string]$MarkerValue)
  $modules = Join-Path $root 'node_modules'
  $old = Join-Path $runtime ('modules-backup-' + [guid]::NewGuid().ToString('N'))
  $hadModules = Test-Path -LiteralPath $modules
  if ($hadModules) {
    Move-Item -LiteralPath $modules -Destination $old
  }
  $env:npm_config_cache = Join-Path $runtime 'npm-cache'
  $env:npm_config_update_notifier = 'false'
  $env:npm_config_prefix = Join-Path $runtime 'npm-prefix'
  $locked = Test-Path -LiteralPath (Join-Path $root 'package-lock.json')
  if (-not $locked) {
    Write-Warning 'No package-lock.json: dependency resolution is not reproducible yet.'
  }
  $succeeded = $false
  try {
    foreach ($attempt in 1..2) {
      if (Test-Path -LiteralPath $modules) {
        Remove-Item -LiteralPath $modules -Recurse -Force
      }
      $command = if ($locked) { 'ci' } else { 'install' }
      Write-Host "Installing dependencies ($command), attempt $attempt of 2..."
      & $Executable $NpmFile $command --no-audit --no-fund --omit=dev --loglevel=error
      if ($LASTEXITCODE -eq 0 -and (Assert-Dependencies $Executable)) {
        $succeeded = $true
        break
      }
      Write-Warning "Dependency installation failed on attempt $attempt."
    }
    if (-not $succeeded) {
      throw 'Dependencies did not install or verify. Check network, antivirus, architecture, and available disk space.'
    }
    Set-Content -LiteralPath $Marker -Value $MarkerValue -Encoding ascii
    if ($hadModules) { Remove-Item -LiteralPath $old -Recurse -Force }
  } finally {
    if (-not $succeeded) {
      Remove-Item -LiteralPath $modules -Recurse -Force -ErrorAction SilentlyContinue
      if ($hadModules -and (Test-Path -LiteralPath $old)) {
        Move-Item -LiteralPath $old -Destination $modules
      }
    }
  }
}
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
Test-WriteAccess $root
Test-WriteAccess $runtime
Test-FreeSpace $root
Write-Host "TENSEI preflight OK: Windows $arch, writable folder, sufficient drive space."
if ($PreflightOnly) {
  Write-Host 'TENSEI_PREFLIGHT_OK'
  exit 0
}
$hashAlg = [System.Security.Cryptography.SHA256]::Create()
try {
  $hash = [BitConverter]::ToString($hashAlg.ComputeHash(
    [Text.Encoding]::UTF8.GetBytes($root))).Replace('-','').Substring(0,20)
} finally { $hashAlg.Dispose() }
$mutex = New-Object System.Threading.Mutex($false, ('Local\TENSEI_' + $hash))
$locked = $false
try {
  try { $locked = $mutex.WaitOne(0) }
  catch [System.Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) {
    throw 'TENSEI is already running from this folder. Close the first window.'
  }
  Write-Host "TENSEI portable Windows $arch | $root"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $nodeDir = Join-Path $runtime ('node-' + $arch)
  $node = Join-Path $nodeDir 'node.exe'
  $npm = Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'
  if (-not (Assert-Node $node $npm)) { Invoke-NodeDownload $nodeDir }
  if (-not (Assert-Node $node $npm)) { throw 'Portable Node.js verification failed.' }
  $marker = Join-Path $runtime 'dependency-architecture.txt'
  $hashFile = if (Test-Path -LiteralPath (Join-Path $root 'package-lock.json')) {
    Join-Path $root 'package-lock.json'
  } else { Join-Path $root 'package.json' }
  $packageHash = (Get-FileHash -LiteralPath $hashFile -Algorithm SHA256).Hash
  $markerValue = $arch + '|' + $version + '|' + $packageHash
  $previous = if (Test-Path -LiteralPath $marker) {
    (Get-Content -LiteralPath $marker -Raw).Trim()
  } else { '' }
  if ($previous -ne $markerValue -or -not (Assert-Dependencies $node)) {
    Install-Dependencies $node $npm $marker $markerValue
  }
  foreach ($entry in @('server.mjs','app.js','analytics.js','legion.js')) {
    & $node --check (Join-Path $root $entry)
    if ($LASTEXITCODE -ne 0) { throw "Syntax error in $entry" }
  }
  Write-Host 'TENSEI ready. If browser does not open, use URL shown below.'
  $env:PORT = '0'
  & $node (Join-Path $root 'server.mjs')
  if ($LASTEXITCODE -ne 0) { throw "TENSEI stopped with exit code $LASTEXITCODE" }
} catch {
  Write-Host ('TENSEI ERROR: ' + $_.Exception.Message) -ForegroundColor Red
  Write-Host 'Check internet, antivirus, disk space, Windows permissions or proxy.'
  Write-Host 'Your data and reports were not deleted.'
  exit 1
} finally {
  if ($locked) { try { $mutex.ReleaseMutex() } catch {} }
  $mutex.Dispose()
}
