$ErrorActionPreference = "Stop"
$installer = Get-ChildItem "apps/desktop/release/Lumen-Setup-*.exe" | Select-Object -First 1
if ($null -eq $installer) { throw "NSIS installer is missing" }

$outer = Join-Path $env:RUNNER_TEMP "lumen-nsis-outer"
$innerDirectory = Join-Path $env:RUNNER_TEMP "lumen-nsis-app"
New-Item -ItemType Directory -Force -Path $outer, $innerDirectory | Out-Null
& 7z x -y "-o$outer" $installer.FullName | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not extract NSIS installer" }
$archive = Get-ChildItem $outer -Recurse -Filter "app-*.7z" | Select-Object -First 1
if ($null -eq $archive) { throw "NSIS app payload is missing" }
$listing = & 7z l -slt $archive.FullName
if ($LASTEXITCODE -ne 0 -or ($listing -match "BCJ2")) { throw "NSIS app payload uses an unsupported BCJ2 filter" }
& 7z x -y "-o$innerDirectory" $archive.FullName | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not extract NSIS app payload" }

foreach ($path in @("Lumen.exe", "resources/native/mpv.exe", "resources/native/mpv-manifest.json", "resources/app.asar")) {
  $shipped = Join-Path $innerDirectory $path
  $unpacked = Join-Path "apps/desktop/release/win-unpacked" $path
  if (!(Test-Path $shipped) -or !(Test-Path $unpacked)) { throw "Missing installed payload file: $path" }
  if ((Get-FileHash $shipped).Hash -ne (Get-FileHash $unpacked).Hash) { throw "Installed payload differs from verified app: $path" }
}
& bun scripts/verify-native-binaries.ts --native-dir (Join-Path $innerDirectory "resources/native")
if ($LASTEXITCODE -ne 0) { throw "Installed native binaries do not match the manifest" }
