#!/usr/bin/env bash
set -euo pipefail

read -r -a browsers <<< "${E2E_BROWSERS:-}"
# macOS ships Bash 3.2, where an empty array trips nounset without this guard.
for browser in ${browsers[@]+"${browsers[@]}"}; do
  case "$browser" in
    chromium|firefox|webkit) ;;
    *) echo "Unsupported browser: $browser" >&2; exit 1 ;;
  esac
done

install_linux_packages() {
  sudo apt-get update
  local packages=(ffmpeg) missing status=0
  if [[ "$E2E_NATIVE" == true ]]; then
    packages+=(mpv)
  fi
  if [[ "$E2E_NATIVE" == true ]] || (( ${#browsers[@]} )); then
    packages+=(xvfb openbox x11-utils pulseaudio pulseaudio-utils)
  fi
  if (( ${#browsers[@]} )); then
    missing=$(bun run playwright install-deps --dry-run "${browsers[@]}") || status=$?
    printf '%s\n' "$missing"
    if (( status != 0 )); then
      # Playwright reports missing packages without installing them. Reject
      # unexpected output instead of silently proceeding with incomplete libraries.
      if (( status != 1 )) || ! grep -Eq '^Missing system dependencies \([0-9]+\):$' <<< "$missing"; then
        return 1
      fi
      while read -r package; do
        [[ "$package" =~ ^[a-z0-9][a-z0-9.+:-]*$ ]] || return 1
        packages+=("$package")
      done < <(sed -n 's/^  //p' <<< "$missing")
    fi
  fi
  sudo apt-get install -y --no-install-recommends "${packages[@]}"
}

if [[ "$RUNNER_OS" == Linux ]]; then
  install_linux_packages &
  packages_pid=$!
  # Always reap the installer, including when a concurrent download fails.
  trap 'wait "$packages_pid"' EXIT
elif [[ "$RUNNER_OS" == macOS ]]; then
  # Native tests use the MPV that bundle-mpv builds from its pinned release.
  brew install ffmpeg
elif [[ "$RUNNER_OS" == Windows ]]; then
  # Windows native tests use the renamed MPV executable from bundle-mpv. FFmpeg is the build
  # Chocolatey would install, taken from its GitHub release: the community feed answers 5xx for
  # minutes at a time.
  ffmpeg_build=ffmpeg-9.0.2-essentials_build
  ffmpeg_dir="$HOME/.cache/ffmpeg/$ffmpeg_build"
  if [[ ! -x "$ffmpeg_dir/bin/ffmpeg.exe" ]]; then
    download=$(mktemp -d)
    curl -fsSL --retry 5 --retry-all-errors -o "$download/ffmpeg.7z" \
      "https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/$ffmpeg_build.7z"
    echo "4705843ccaaf54257c16ad90f3e952ece33c17df964ecf7bfdbb0f49c7171077  $download/ffmpeg.7z" \
      | sha256sum -c --status
    7z x -y -bd -o"$(cygpath -w "$download")" "$(cygpath -w "$download/ffmpeg.7z")" > /dev/null
    mkdir -p "$(dirname "$ffmpeg_dir")"
    mv "$download/$ffmpeg_build" "$ffmpeg_dir"
    rm -rf "$download"
  fi
  export PATH="$ffmpeg_dir/bin:$PATH"
  cygpath -w "$ffmpeg_dir/bin" >> "$GITHUB_PATH"
fi

if (( ${#browsers[@]} )); then
  PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 bun run playwright install --only-shell "${browsers[@]}"
fi
if [[ "$E2E_NATIVE" == true ]]; then
  bun apps/desktop/node_modules/electron/install.js
fi
if [[ "$RUNNER_OS" == Linux ]]; then
  wait "$packages_pid"
  trap - EXIT
fi
# Every suite that builds media needs these; fail here rather than in each test.
ffmpeg -hide_banner -version > /dev/null
ffprobe -hide_banner -version > /dev/null
if (( ${#browsers[@]} )); then
  # Validate libraries only after apt finishes, including on browser cache hits.
  bun run playwright install --only-shell "${browsers[@]}"
fi
