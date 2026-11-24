<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="apps/desktop/resources/brand/lumen-lockup-dark.svg">
  <img alt="Lumen" src="apps/desktop/resources/brand/lumen-lockup-light.svg" width="260">
</picture>

**Your movies, shows, and music, streamed from your own server.**

A self-hosted media server with a fast desktop app, a web app for everywhere else, and playback that adapts to your connection.

[![Server release](https://img.shields.io/github/v/release/HamzaNa1/lumen?filter=*%2Bserver&label=server)](https://github.com/HamzaNa1/lumen/releases)
[![Desktop release](https://img.shields.io/github/v/release/HamzaNa1/lumen?filter=*%2Bdesktop&label=desktop)](https://github.com/HamzaNa1/lumen/releases/latest)
[![Checks](https://img.shields.io/github/actions/workflow/status/HamzaNa1/lumen/checks.yml?branch=main&label=checks)](https://github.com/HamzaNa1/lumen/actions/workflows/checks.yml)

[Install](#install) · [Features](#features) · [Apps](#get-the-apps) · [Home and away](#at-home-and-away) · [Configuration](#configuration) · [FAQ](#faq)

<!-- TODO: hero screenshot of the home screen (desktop app, dark theme), ~1600px wide -->
<img alt="Lumen home screen" src="docs/images/home.png" width="900">

</div>

> [!WARNING]
> Lumen is in early development. Expect rough edges and frequent releases. Your media is safe either way: Lumen only ever reads your library folders, never writes to them.

## Why Lumen?

Lumen is an alternative to Plex and Jellyfin for people who want their media server to be fast, quiet, and dependable.

- **Plays everything, everywhere.** When a device can't play a file, or the connection can't carry it, the server converts it on the fly with FFmpeg, on the CPU or a GPU. The same library plays in the desktop app and in any browser.
- **Feels instant.** Browsing, seeking, and switching tracks respond immediately, without spinners or layouts that jump as data arrives.
- **Built to run unattended.** Unplug a drive and its library stays put until it comes back. Laptops that sleep mid-download pick up where they left off. A busy server says no instead of grinding to a halt.
- **Your files are read-only to Lumen.** It never renames, moves, tags, or deletes anything in your library.

## Features

**Library**

- Movies, TV shows, and music libraries, each built from one or more folders
- Artwork, descriptions, and episode order from [TMDb](https://www.themoviedb.org) or your own `.nfo` files, with manual matching when the guess is wrong
- New, changed, and removed files show up on their own, with no manual rescan
- Continue watching, Next up, resume where you left off, and watched state across all your devices

**Playback**

- **Auto** quality picks between the original file and 1080p, 720p, 480p, or 360p as your connection changes, without stalling; or pick one yourself
- Lumen remembers your quality, audio, and subtitle choices for each show
- Conversion with FFmpeg on the CPU, NVIDIA (NVENC), or Intel/AMD (VAAPI), with limits so a busy server turns work away instead of falling over
- Seeking and track switching keep working during conversion
- A desktop player built on [MPV](https://mpv.io)
- Near the end of an episode, the desktop app starts loading the next one, so it starts right away when you move on
- Playback info shows exactly how a stream is delivered: original or converted, which quality, and how much is buffered

**Offline**

- Download movies and episodes to the desktop app and watch them without a connection
- Keep the next 1, 3, or 5 unwatched episodes of a show downloaded automatically
- Watched downloads clean themselves up; mark any download as Keep to hold onto it
- Downloads pause when the disk fills and resume as soon as space comes back
- Progress you make offline syncs when you reconnect

**Together**

- Watch groups keep everyone on the same frame: play, pause, and seek in sync, from the desktop or the browser

**Connections**

- The desktop app finds servers on your network without typing an address
- Each server can have several addresses (home network, VPN, and the internet), and the app switches to the best one that answers, after sleep or a network change
- On your home network the app connects over HTTPS to a certificate it has pinned, so your sign-in never crosses the network in plain text
- Tailscale, WireGuard, ZeroTier, and other VPN addresses are recognized and used when you're away from home

**Accounts**

- Multiple accounts per server, with administrators and viewers
- Per-library access and per-person permissions such as downloading
- Sign in to several servers from one desktop app

## Install

The server runs on Linux, either in Docker or as a system service. You need a machine that can see your media folders.

### Docker

```sh
docker run -d --name lumen \
  --restart unless-stopped \
  -p 3210:3210 -p 3211:3211 \
  -e LUMEN_LAN_ORIGINS=http://192.168.1.10:3210,https://192.168.1.10:3211 \
  -v lumen-data:/data \
  -v /path/to/media:/media:ro \
  ghcr.io/hamzana1/lumen-server:latest
```

Or with Docker Compose:

```yaml
services:
  lumen:
    image: ghcr.io/hamzana1/lumen-server:latest
    restart: unless-stopped
    ports:
      - 3210:3210 # HTTP
      - 3211:3211 # HTTPS for apps on your network
    environment:
      # The host's addresses, which a container can't see on its own.
      LUMEN_LAN_ORIGINS: http://192.168.1.10:3210,https://192.168.1.10:3211
    volumes:
      - lumen-data:/data
      - /path/to/media:/media:ro
    # For hardware-accelerated conversion on Intel/AMD:
    # devices:
    #   - /dev/dri:/dev/dri

volumes:
  lumen-data:
```

Replace `192.168.1.10` with your server's address on your network. Images are published for AMD64 and ARM64.

### Linux service

On a systemd distribution with glibc (AMD64 or ARM64):

```sh
curl -fsSL https://github.com/HamzaNa1/lumen/releases/download/server-latest/install.sh | sudo sh
# Options go after `sh -s --`: --auto-update, or --version=X.Y.Z for a specific release.
```

The installer sets up FFmpeg if it's missing and starts Lumen as the `lumen` service. Give the `lumen` user read access to your media folders. Settings live in `/etc/lumen/lumen.env` and data in `/var/lib/lumen`; both survive updates and uninstalls.

```sh
sudo lumenctl status               # version, available update, service and FFmpeg state
sudo lumenctl update               # install the latest release now
sudo lumenctl auto-update on       # or off: a daily check between 04:00 and 05:00
sudo lumenctl uninstall [--purge]  # --purge also removes settings, data, and the user
```

Updates only move forward. A download that fails its checksum leaves the installed version running, and running the installer again repairs an installation.

### First run

1. Open the desktop app and pick your server from the list, or enter its address. In a browser, go to `http://<your-server>:3210/web`.
2. Create the first account. It becomes the administrator.
3. Under **Administration → Libraries**, add a library and pick its folders.
4. Optional: add a TMDb API key on the same page, for artwork and descriptions. Local `.nfo` files and artwork are always used.
5. Invite everyone else from **Administration → Users**.

## Get the apps

| Platform | Download | Notes |
| --- | --- | --- |
| macOS (Apple Silicon) | [`.dmg`](https://github.com/HamzaNa1/lumen/releases/latest) | Not notarized yet: the first launch needs **Open Anyway** in System Settings → Privacy & Security. |
| Windows | [Installer or portable `.exe`](https://github.com/HamzaNa1/lumen/releases/latest) | The installed app updates itself. |
| Linux (x64) | [AppImage or `.deb`](https://github.com/HamzaNa1/lumen/releases/latest) | |
| Any browser | `http://<your-server>:3210/web` | No downloads or offline playback. |

The desktop app and server update independently. Any recent desktop works with any recent server. **Settings** shows the app, server, and MPV versions you're running.

## At home and away

A desktop app remembers every address it can reach a server at, and moves to the best one that answers, in this order: the same machine, your home network, a VPN, then the internet. You can see, add, reorder, and remove addresses under **Settings → Routes**.

- **Home network.** The server advertises its own addresses. Apps on your network use HTTPS on the next port up (`3211` by default) with a self-signed certificate. The app learns that certificate over a connection it already trusts and accepts only that one, so there is nothing to install or click through.
- **VPN.** Addresses on Tailscale, WireGuard, ZeroTier, OpenVPN, and similar tunnels are advertised as VPN routes. In Docker, list them in `LUMEN_LAN_ORIGINS`; Tailscale addresses and `.ts.net` names there count as VPN.
- **Internet.** Put Lumen behind your own reverse proxy with HTTPS (see below) and add that address to the app. The app never sends its sign-in token to a plain-HTTP address it found on its own.

## Configuration

Most settings, including libraries, users, metadata, and conversion, are managed in the app. The server itself reads a few environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `LUMEN_PORT` | `3210` | HTTP port |
| `LUMEN_TLS_PORT` | `LUMEN_PORT + 1` | HTTPS port for apps on your network, or `off` |
| `LUMEN_HOST` | `0.0.0.0` in Docker | Address to bind |
| `LUMEN_DATA_DIR` | `/data` in Docker | Where the database, artwork, and certificate live |
| `LUMEN_LAN_ORIGINS` | | Addresses to advertise to apps, comma-separated. Needed in Docker |
| `LUMEN_LAN_DISCOVERY` | `auto` | Let desktop apps on your network find this server, or `off` |
| `LUMEN_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |
| `LUMEN_LOG_FORMAT` | `text` | `json` for log collectors |
| `LUMEN_LIBRARY_WATCH_INTERVAL_MS` | `60000` | How often libraries are checked for changes |
| `LUMEN_COOKIE_SECURE` | `auto` | Browser sign-in cookie: `auto`, `always`, or `never` |
| `LUMEN_ALLOWED_ORIGINS` | | Extra origins for browser sign-in, comma-separated |
| `LUMEN_TRUSTED_PROXIES` | | Proxy IPs whose `X-Forwarded-For` is believed, for per-client rate limits |

See [`.env.example`](.env.example) for more.

### Behind a reverse proxy

Lumen works behind Caddy, nginx, Traefik, and friends. Browser sessions are tied to the address the web app was loaded from, so:

- Forward `X-Forwarded-Proto` and `X-Forwarded-Host`.
- If your proxy rewrites `Host` without setting `X-Forwarded-Host`, list your public address in `LUMEN_ALLOWED_ORIGINS`, for example `https://media.example.com`.
- List the proxy's IP in `LUMEN_TRUSTED_PROXIES` so rate limits apply per viewer rather than to the proxy as a whole.

Over HTTPS the sign-in cookie is marked `Secure` automatically. Set `LUMEN_COOKIE_SECURE=always` to refuse sign-in over plain HTTP.

## FAQ

<details>
<summary><b>How is this different from Jellyfin or Plex?</b></summary>

Lumen is built specifically for movies and shows, and it does less on purpose: no plugins, live TV, or mobile and TV apps (yet). What it focuses on instead:

- **Bad networks.** Playback adapts its quality to the connection instead of stalling, and the desktop app moves between your home network, a VPN, and the internet on its own, picking up again after sleep or a dropped connection.
- **Watch groups that stay in sync.** Everyone in a group stays on the same frame through play, pause, and seek, from the desktop or the browser.
- **Offline downloads.** Download movies and episodes to the desktop app, keep the next episodes of a show ready automatically, and watch with no connection at all. Your progress syncs when you're back.

</details>

<details>
<summary><b>Do I need a GPU?</b></summary>

No. Conversion runs on the CPU by default. A GPU lets the server convert more streams at once: choose NVENC or VAAPI under **Settings → Transcoding**, and pass the device through if you use Docker.

</details>

<details>
<summary><b>What does conversion support?</b></summary>

Lumen converts to H.264 video with stereo AAC audio, in 4-second pieces at up to four qualities (1080p down to 360p, never above the original). Any input your FFmpeg build can decode works. HDR tone mapping and surround sound aren't supported in converted streams yet.

</details>

<details>
<summary><b>Why can't I see subtitles in the browser?</b></summary>

Browsers can't show the subtitle tracks inside a video file, so the web app plays without them for now. The desktop app shows every subtitle track MPV can read.

</details>

<details>
<summary><b>Does Lumen modify my media files?</b></summary>

Never. Library folders are read-only to Lumen. Mount them read-only (`:ro`) to make sure.

</details>

<details>
<summary><b>How do I back up Lumen?</b></summary>

Everything Lumen knows lives in its data directory (`/data` in Docker, `/var/lib/lumen` for the Linux service). Stop the server and copy that directory. That includes the HTTPS certificate desktop apps on your network have pinned. Your media is never touched, so it only needs whatever backup you already give it.

</details>

## Contributing

Bug reports and ideas are welcome in [Issues](https://github.com/HamzaNa1/lumen/issues). To work on Lumen, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

<!-- TODO: the repository has no LICENSE file yet. -->
