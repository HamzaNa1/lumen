#!/usr/bin/env bash
# Builds libmpv from mpv's pinned release source against Homebrew's libraries, bundles it, and
# builds the video helper against its headers. Homebrew moves mpv itself to new releases.
set -euo pipefail
if [[ "$(uname -m)" != 'arm64' ]]; then
  echo 'macOS releases require an Apple Silicon runner.' >&2
  exit 1
fi
mpv_version='0.41.0'
mpv_sha256='ee21092a5ee427353392360929dc64645c54479aefdb5babc5cfbb5fad626209'
brew install --quiet meson ninja pkgconf dylibbundler ffmpeg jpeg-turbo libarchive libass \
  libbluray libplacebo little-cms2 luajit mujs rubberband uchardet vulkan-loader zimg
native_dir="apps/desktop/resources/native"
build="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT
curl -fsSL --retry 3 -o "$build/mpv.tar.gz" \
  "https://github.com/mpv-player/mpv/archive/refs/tags/v$mpv_version.tar.gz"
if [[ "$(shasum -a 256 "$build/mpv.tar.gz" | awk '{ print $1 }')" != "$mpv_sha256" ]]; then
  echo "SHA-256 mismatch for mpv $mpv_version" >&2
  exit 1
fi
tar -xzf "$build/mpv.tar.gz" -C "$build"
mpv_prefix="${MPV_PREFIX:-$build/mpv}"
# libarchive is keg-only, so pkg-config only finds it through its own prefix.
PKG_CONFIG_PATH="$(brew --prefix libarchive)/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}" \
  meson setup "$build/mpv-build" "$build/mpv-$mpv_version" --prefix "$mpv_prefix" \
  --buildtype release -Dbuild-date=false -Dhtml-build=disabled -Dmanpage-build=disabled \
  -Dlibmpv=true -Djavascript=enabled -Dlua=luajit -Dlibarchive=enabled -Duchardet=enabled \
  -Dvulkan=enabled -Dvapoursynth=disabled
meson install -C "$build/mpv-build" --quiet
mkdir -p "$native_dir/lib"
cp "$mpv_prefix/lib/libmpv.dylib" "$native_dir/libmpv.dylib"
install_name_tool -id @loader_path/libmpv.dylib "$native_dir/libmpv.dylib"
dylibbundler -od -b -x "$native_dir/libmpv.dylib" -d "$native_dir/lib" -p '@loader_path/lib/'
bun apps/desktop/scripts/prepare-macos-libraries.ts "$native_dir"
cmake -S apps/desktop/native -B "$build/helper" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES=arm64 -DMPV_INCLUDE_DIR="$mpv_prefix/include"
cmake --build "$build/helper" --parallel
ctest --test-dir "$build/helper" --output-on-failure
cp "$build/helper/Lumen Video Helper" "$native_dir/"
codesign --force --sign - "$native_dir/Lumen Video Helper"
if [[ -n "${GITHUB_ENV:-}" ]]; then echo "LUMEN_MPV_VERSION=$mpv_version" >> "$GITHUB_ENV"; fi
