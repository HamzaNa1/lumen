$ErrorActionPreference = "Stop"
$native = Join-Path $PWD "apps/desktop/resources/native"
$build = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Force -Path $native, $build | Out-Null
function Download-Verified($url, $destination, $sha256) {
    Invoke-WebRequest $url -OutFile $destination
    if ((Get-FileHash $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha256) {
        throw "SHA-256 mismatch for $url"
    }
}
try {
    $release = "https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/20261021"
    Download-Verified "$release/mpv-dev-x86_64-20261021-git-e471496c56.7z" "$build/dev.7z" "efc719eff3dc5954b4a5efc800632808bcec01cc9034940dd14e5eb7fe9ea633"
    Download-Verified "$release/mpv-x86_64-20261021-git-e471496c56.7z" "$build/mpv.7z" "4a355f3e89c83fabc730d33fb4e759dfec747806ed2287b61a90d1681b83e8d3"
    # libmpv imports vulkan-1.dll even when using its D3D11 renderer. Use the
    # matching Electron redistribution for that loader and the shader compiler.
    Download-Verified "https://github.com/electron/electron/releases/download/v44.4.5/electron-v44.4.5-win32-x64.zip" "$build/electron.zip" "11c395820a5aaa8ebcc0686b476d0ac98a730274ebfbdc8cf5538a7c2815cb5d"
    & 7z x -y "$build/dev.7z" "-o$build/dev" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "libmpv extraction failed" }
    & 7z x -y "$build/mpv.7z" "-o$build/mpv" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "mpv extraction failed" }
    Expand-Archive "$build/electron.zip" "$build/electron"
    foreach ($header in @("client.h", "render.h")) {
        if ((Get-FileHash "$build/dev/include/mpv/$header").Hash -ne (Get-FileHash "apps/desktop/native/vendor/mpv/$header").Hash) {
            throw "Packaged libmpv header differs from pinned build header: $header"
        }
    }
    Copy-Item "$build/dev/libmpv-2.dll" $native -Force
    Copy-Item "$build/mpv/mpv.exe" $native -Force
    Copy-Item "$build/mpv/d3dcompiler_43.dll" $native -Force
    foreach ($library in @("vulkan-1.dll", "d3dcompiler_47.dll")) {
        Copy-Item "$build/electron/$library" $native -Force
    }
    $licenses = Join-Path $native "licenses"
    New-Item -ItemType Directory -Force -Path $licenses | Out-Null
    Copy-Item "apps/desktop/native/vendor/mpv/Copyright" "$licenses/mpv-Copyright" -Force
    Copy-Item "apps/desktop/native/vendor/mpv/LICENSE.GPL" "$licenses/mpv-LICENSE.GPL" -Force
    Copy-Item "$build/electron/LICENSE" "$licenses/electron-LICENSE" -Force
    Copy-Item "$build/electron/LICENSES.chromium.html" "$licenses/electron-LICENSES.chromium.html" -Force
    Copy-Item "apps/desktop/native/dependencies.json" "$native/dependencies.json" -Force
    & cmake -S apps/desktop/native -B "$build/helper" -A x64
    if ($LASTEXITCODE -ne 0) { throw "Helper CMake configuration failed" }
    & cmake --build "$build/helper" --config Release --parallel
    if ($LASTEXITCODE -ne 0) { throw "Helper compilation failed" }
    & ctest --test-dir "$build/helper" -C Release --output-on-failure
    if ($LASTEXITCODE -ne 0) { throw "Helper protocol tests failed" }
    Copy-Item "$build/helper/Release/Lumen Video Helper.exe" $native -Force
    $env:LUMEN_MPV_VERSION = "20261021-git-e471496c56-client-api-2.6"
    if ($env:GITHUB_ENV) { "LUMEN_MPV_VERSION=$env:LUMEN_MPV_VERSION" >> $env:GITHUB_ENV }
} finally {
    Remove-Item -Recurse -Force $build
}
