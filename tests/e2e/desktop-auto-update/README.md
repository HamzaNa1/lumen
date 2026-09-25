# Packaged desktop update smoke test

Run this release gate explicitly on disposable macOS ARM64, Windows per-user NSIS, and Linux AppImage machines. It is outside the default `bun test` suite because it installs and replaces real applications.

Build two updater-enabled packages, A and B, with B at a higher stable version. Use the production app ID, bundle identity, package target, and signing identity. Configure `publish` in a temporary builder config for a separate controlled GitHub test repository. Do not override feeds at runtime and do not publish test packages in `HamzaNa1/lumen`. Keep the test feed private to the test environment; the production app needs no GitHub token.

1. Install and launch A from a writable installed location. On macOS copy the app out of the mounted DMG. On Windows use the per-user NSIS installer. On Linux launch the AppImage itself and record its path and launcher shortcut.
2. Connect to a test media server, record the installation identity and saved account, and start playback. Run `bun tests/e2e/desktop-auto-update/probe.ts snapshot <app.asar> <installation.json> <snapshot.json>`.
3. Publish B in the controlled feed with its manifest and blockmap. Wait for the Settings Updates card to show download progress and then “Update ready.” Confirm A still plays media and reports version A. A corrupt payload or failed macOS staging must never show ready.
4. Quit normally. Confirm MPV and bridge sockets exit and no Lumen window reopens. Launch again from the same shortcut or path. Run `bun tests/e2e/desktop-auto-update/probe.ts verify <app.asar> <installation.json> <snapshot.json> <B-version>`. Verify the account still works and playback starts. Launch B once more to check for an install loop.
5. Repeat with offline startup, interrupted network, damaged download, cache deletion, low disk space, unwritable location, immediate relaunch, and kill during download and after readiness. On Windows also exercise file locks and antivirus. On Linux move the AppImage and check executable permission and launcher integration. Exercise OS logout/reboot and an interrupted installer on disposable machines.

Do not publish a target if an interrupted update corrupts the installation without a tested signed-installer recovery path. A normal quit is the install boundary; a crash or OS shutdown does not guarantee replacement on the next launch.
