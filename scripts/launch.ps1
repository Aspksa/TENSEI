param()
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $root
$runtime = Join-Path $root '.runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  'AMD64' { 'win-x64' }
  'ARM64' { 'win-arm64' }
  default { throw "TENSEI supports Windows 10/11 64-bit (AMD64/ARM64). Architecture: $env:PROCESSOR_ARCHITECTURE" }
}
$version = 'v22.16.0'
$nodeDir = Join-Path $runtime ('node-' + $arch)
$node = Join-Path $nodeDir 'node.exe'
$npm = Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'
$hashAlg = [System.Security.Cryptography.SHA256]::Create()
try {
  $hash = [BitConverter]::ToString($hashAlg.ComputeHash([Text.Encoding]::UTF8.GetBytes($root))).Replace('-','').Substring(0,20)
} finally { $hashAlg.Dispose() }
$mutex = New-Object System.Threading.Mutex($false, ('Local\TENSEI_' + $hash))
$locked = $false
try {
  try { $locked = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { throw 'TENSEI is already running from this folder. Close the first window before restarting.' }
  Write-Host "TENSEI | Portable Windows $arch | path: $root"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
    Write-Host '[1/3] Downloading portable Node.js (one time per architecture)...'
    $fileName = "node-$version-$arch.zip"
    $baseUrl = "https://nodejs.org/dist/$version"
    $archive = Join-Path $runtime $fileName
    $hashFile = Join-Path $runtime 'node-checksums.txt'
    Invoke-WebRequest -Uri "$baseUrl/$fileName" -OutFile $archive -UseBasicParsing
    Invoke-WebRequest -Uri "$baseUrl/SHASUMS256.txt" -OutFile $hashFile -UseBasicParsing
    $line = Get-Content -LiteralPath $hashFile | Where-Object { $_ -match ('\s' + [regex]::Escape($fileName) + '$') } | Select-Object -First 1
    if (-not $line) { throw 'Official SHA256 checksum was not found for Node.js.' }
    $expected = ($line.Trim() -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw 'Node.js archive checksum mismatch. Installation stopped.' }
    $extracted = Join-Path $runtime "node-$version-$arch"
    if (Test-Path -LiteralPath $extracted) { Remove-Item -LiteralPath $extracted -Recurse -Force }
    Expand-Archive -LiteralPath $archive -DestinationPath $runtime -Force
    if (Test-Path -LiteralPath $nodeDir) { Remove-Item -LiteralPath $nodeDir -Recurse -Force }
    Move-Item -LiteralPath $extracted -Destination $nodeDir
    Remove-Item -LiteralPath $archive,$hashFile -Force -ErrorAction SilentlyContinue
  }
  if (-not (Test-Path -LiteralPath $npm -PathType Leaf)) { throw 'Portable npm installation is damaged.' }
  Write-Host '[2/3] Checking dependencies...'
  $marker = Join-Path $runtime 'dependency-architecture.txt'
  $packageHash = (Get-FileHash -LiteralPath (Join-Path $root 'package.json') -Algorithm SHA256).Hash
  $markerValue = $arch + '|' + $packageHash
  $nodeModules = Join-Path $root 'node_modules'
  $previous = if (Test-Path -LiteralPath $marker) { (Get-Content -LiteralPath $marker -Raw).Trim() } else { '' }
  if ($previous -ne $markerValue -or -not (Test-Path -LiteralPath (Join-Path $nodeModules 'sharp')) -or -not (Test-Path -LiteralPath (Join-Path $nodeModules 'exceljs')) -or -not (Test-Path -LiteralPath (Join-Path $nodeModules 'bmp-js'))) {
    Write-Host 'Installing platform dependencies on external drive...'
    if ($previous -and ($previous -split '\|')[0] -ne $arch -and (Test-Path -LiteralPath $nodeModules)) {
      Remove-Item -LiteralPath $nodeModules -Recurse -Force
    }
    $env:npm_config_cache = Join-Path $runtime 'npm-cache'
    $env:npm_config_update_notifier = 'false'
    $env:npm_config_prefix = Join-Path $runtime 'npm-prefix'
    & $node $npm install --no-audit --no-fund --omit=dev --loglevel=error
    if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)" }
    Set-Content -LiteralPath $marker -Value $markerValue -Encoding ascii
  }
  Write-Host '[3/3] Verifying installation and starting the local interface...'
  & $node -e "require('sharp');require('bmp-js');require('exceljs')"
  if ($LASTEXITCODE -ne 0) { throw 'Dependency check failed. Remove node_modules and restart to reinstall.' }
  & $node --check (Join-Path $root 'server.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Server syntax check failed.' }
  & $node --check (Join-Path $root 'app.js')
  if ($LASTEXITCODE -ne 0) { throw 'UI syntax check failed.' }
  Write-Host 'Open the local URL shown below if the browser does not start.'
  $env:PORT = '0'
  & $node (Join-Path $root 'server.mjs')
  if ($LASTEXITCODE -ne 0) { throw "TENSEI stopped with exit code $LASTEXITCODE" }
} catch {
  Write-Host ''
  Write-Host ('TENSEI ERROR: ' + $_.Exception.Message) -ForegroundColor Red
  Write-Host 'Check internet access, antivirus rules, space on the SSD, and Windows permissions.' -ForegroundColor Yellow
  exit 1
} finally {
  if ($locked) { try { $mutex.ReleaseMutex() } catch {} }
  $mutex.Dispose()
}
