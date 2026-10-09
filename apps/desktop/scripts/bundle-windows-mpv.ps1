$ErrorActionPreference = "Stop"
choco install mpvio.portable --version 0.41.0 --yes --no-progress
if ($LASTEXITCODE -ne 0) { throw "MPV installation failed" }
"LUMEN_MPV_VERSION=0.41.0" >> $env:GITHUB_ENV
$source = Get-ChildItem "$env:ChocolateyInstall\lib\mpvio.portable\tools" -Filter mpv.exe -Recurse | Select-Object -First 1
if ($null -eq $source) { throw "Chocolatey did not install mpv.exe" }
$native = "apps/desktop/resources/native"
New-Item -ItemType Directory -Force -Path $native | Out-Null
Copy-Item "$($source.DirectoryName)\*" $native -Recurse -Force
