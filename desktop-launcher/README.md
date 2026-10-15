# Personal DSH Launcher

English | [中文](README.zh.md)

## Summary

Run DeepSeek Harness in an Electron window with a private data directory, scoped proxies, service controls, and staged updates from the official GitHub repository. This independent project lives outside the DSH pnpm workspace. Build targets are macOS Apple Silicon and Windows x64; this launcher does not replace the official Desktop application. Windows requires a native build and its own passing smoke checks before an installer is considered ready.

## Contents

- [Build and run](#build-and-run)
- [Windows Git checkout](#windows-checkout)
- [Use the launcher](#use-the-launcher)
- [Updates and recovery](#updates-and-recovery)
- [Development and checks](#development-and-checks)
- [Limitations](#limitations)

## Build and run {#build-and-run}

Developers need Git, Node.js and npm plus the native build tools required by DSH. Run these commands inside `desktop-launcher/`:

```sh
npm ci
npm run setup:electron
npm run prepare:payload
npm start
```

Launcher `.npmrc` disables dependency install scripts; `npm run setup:electron` explicitly prepares the Electron executable before local development or macOS packaging. Windows scripts and CI perform this step explicitly. The exported kit includes `.npmrc`, and resume fingerprints include it. DSH source installation uses its own pnpm lifecycle policy, with inherited npm configuration removed from its child environment.

Payload preparation downloads checksum-verified Node.js, portable Git from desktop/dugite-native, and pnpm. It exports the current tracked Git commit, excludes this launcher, installs the frozen DSH dependency set, builds the product and checks the CLI entry. Tracked modifications must be committed before preparation. Untracked files, credentials and local `.env` files are not copied. The build log and download cache are under `.cache/`; interrupted preparation leaves diagnostic files and may leave a lock that must be removed only after confirming that the preparation process has exited.

Build a local installer after preparing the payload:

```sh
npm run package:mac
```

The DMG appears under `.cache/dist/`. This local build has no Developer ID signing or Apple notarization; macOS may require an explicit security approval. Packaging refuses a missing payload. The installer includes Git, Node, pnpm, the DSH source and built dependencies, so first-run preparation does not install developer tools or fetch npm packages. Model requests and optional plugin downloads still need network access.

### Building from a Windows Git checkout {#windows-checkout}

You can clone your fork on Windows and ask a local coding assistant to build the launcher. This route requires Git, a supported Node.js runtime with npm, and a Windows x64 build environment. The shipped build-kit scripts bootstrap their own pinned tools afterward. Use a short local checkout path and preserve existing changes before pulling. Installing Git and Node for the checkout workflow does not change the self-contained installer requirements.

The repository is not an extracted build kit. Do not run `windows/Build-Windows.cmd` in place. From `desktop-launcher/` in a clean committed checkout, run:

```sh
npm ci
npm run export:windows
```

The exporter uses Node archive libraries without macOS tool paths or symlink creation privileges. `WINDOWS_BUILD_DIRECTORY` identifies the separate build directory; run `Build-Windows.cmd` there. Use `npm run export:windows:zip` for a ZIP. Snapshot metadata records the source commit, version and SHA-256; internal links become ordinary copies, while escaping and cyclic links are rejected. The snapshot includes only committed source and excludes the launcher; do not commit credentials or user data to the source repository. Native Windows validation belongs to CI and the build-kit scripts.

Use this handoff prompt with the assistant in the Windows checkout:

> Read the repository AGENTS.md and desktop-launcher/README.md. Build the independent launcher in desktop-launcher, not the official apps/desktop client. Inspect git status and the fork remote before updating; preserve local changes. Run npm ci and npm run export:windows inside desktop-launcher to prepare the kit. Use the selected committed source revision and preserve snapshot hashes and internal-link validation. Do not archive credentials or local user data. Use Build-Windows.cmd in the generated kit. Configure its proxy.txt with my actual HTTP proxy if needed; do not change global npm/Git settings or disable TLS checks. Keep the locked dependency versions. If changing the launcher version, update only its package.json version and the two root version fields in package-lock.json. Do not replace version strings throughout dependency records. Explicitly install Electron using the existing build script. Run pnpm commands inside the extracted DSH source directory, which declares pnpm. If packaging fails after the payload is complete, use Continue-Packaging.cmd in that same kit to preserve downloads and the compiled payload. Do not skip failing tests. Inspect the not ok sections and the first build error. Deliver the Setup.exe path, SHA-256, source commit and BUILD-SUCCESS.txt only after unit tests, runtime start/restart, packaging, occupied-port and import checks pass. Report unverified installer interaction separately. Do not install or publish it without my request.

The output is an unsigned `DSH-Launcher-<version>-Windows-x64-Setup.exe` under the generated kit's `desktop-launcher/.cache/dist/`. `BUILD-SUCCESS.txt` at the kit root is the script's completion record; an executable appearing before step 7 is not sufficient. Keep the same kit directory for retries so its `proxy.txt`, download cache and completed payload remain available. A Git update changes source files; it does not rebuild an existing installer or refresh an older exported kit.

### Windows build kit

After a completed payload reaches the packaging stage, `Continue-Packaging.cmd` reuses installed dependencies and that payload, explicitly installs Electron, and reruns unit, runtime and packaged checks without rebuilding DSH. Continuation requires a completed build record matching the source archive, manifests, tool pins and launcher build/runtime code. Missing or changed inputs require Build-Windows.cmd; cached downloads remain available. Older payloads without this record require one full build. Full builds also install Electron explicitly before testing.

The Windows kit contains a checksum-verified snapshot of the current committed DSH source, this launcher, and `Build-Windows.cmd`. Extract it to a short local path on an Intel/AMD Windows 10/11 machine, then double-click the command file. pnpm version checks and build commands run in the extracted DSH source directory, which owns the pnpm declaration. Dependency installation explicitly selects the official npm registry without changing global npm configuration. The script downloads pinned Node and Git plus the declared pnpm version, installs dependencies, builds DSH, runs lifecycle tests and a runtime smoke, creates an unsigned NSIS installer, and checks the packaged app with an occupied port and fixture data import. It writes `BUILD-SUCCESS.txt` only after those checks pass; the installer is under `desktop-launcher/.cache/dist/`. It does not install that artifact or change global PATH. Initial builds need internet access; unavailable native prebuilds may require C++ build tools. An optional `proxy.txt` beside the command file sets an HTTP/HTTPS proxy for this build only; an empty or whitespace-only file leaves the environment unchanged. Failures retain `build-windows.log` and scoped logs under `.cache/`. A stale `prepare-windows.lock` may be removed only after every build process has exited.

Windows package-directory links are recorded as relative metadata and recreated as junctions after first-run extraction reaches its permanent directory, so the installed runtime does not reference the build machine. Windows service shutdown uses `taskkill /T /F` and awaits the owned child exit. Windows data lives below `%APPDATA%`; default-data discovery uses `%USERPROFILE%/.dsh`. NSIS installs per user and retains user data on uninstall. Windows builds and native installer interaction cannot be certified by the macOS tests.

## Use the launcher {#use-the-launcher}

The header displays the launcher version read from Electron, separately from the active DSH core version. The compact management window keeps service status and available service actions above four tabs: connection settings, updates, data and logs. The dark blue interface uses green for primary actions and running status, with native window controls. Connection settings group proxy scopes, keep save actions visible at the default window size, and collapse the proxy and API-key guidance. The port field is disabled while the service is running or an operation is active. Tabs support arrow-key navigation and retain unsaved settings. Changed settings show a pending indicator and can be reverted; the GitHub connection test is unavailable until changes are saved or reverted, so it always tests the saved configuration.

The management window opens the DSH workspace in a separate, sandboxed Electron window. Closing the workspace returns to management without stopping the service. Quitting the launcher requests confirmation when a service or build is active, then stops its owned process tree. It does not terminate unrelated DSH applications.

The data directory is Electron's userData directory, normally `~/Library/Application Support/personal-dsh-launcher`. Use Open data directory to find the exact location. `dsh-home/` stores isolated sessions, settings and credentials. `workspace/` is the initial working directory. `versions/` contains managed application copies. `runtime.json` selects the active and prepared versions. Logs rotate at approximately 2 MB and redact URL queries and common credential assignments; arbitrary third-party plugin output can still contain sensitive information.

Import default data detects `~/.dsh`; Refresh detection checks it again. Choose directory imports another DSH home containing `sessions/`, `storages/`, or `profiles/`. Stop every external DSH process using the source first and import only trusted data: profiles and credentials are included. After confirmation, the launcher stops its service, copies the source into staging, retains the previous home under `backups/import-…/dsh-home`, and replaces the client home without merging databases or changing the source. The service stays stopped until Start service. Launcher proxy settings and external project files are not imported. The generated shared `profiles/node_modules/` directory is excluded before inspecting its links, including dangling links to old installations. Profile configuration, plugin manifests and profile-specific dependencies remain subject to normal copying; this operation does not reinstall extra plugins. Overlapping directories and links or special files elsewhere are rejected with the relative path shown in the error. A failed or interrupted swap restores the previous home before startup; a failed restoration blocks startup. Copy failures retain staging files for diagnosis. Import does not convert incompatible session formats; keep the backup if startup reports a version error.

Configure model API keys in the workspace model settings, or import trusted existing DSH data. The service does not inherit terminal API keys.

Proxy settings accept HTTP or HTTPS addresses without embedded credentials. Separate switches apply the proxy to updates and dependency installation, DSH service requests, and workspace browser traffic. Loopback traffic bypasses the proxy. Service changes apply on restart; preferred-port changes require stopping the service. When that port is occupied, the OS assigns a free port for this run; management displays the actual port and the workspace connects to it automatically. The saved preference remains unchanged and is tried again on the next start. The connection test checks GitHub through the saved update proxy, not the model provider. System proxy settings, shell configuration and global Git configuration are not changed.

## Updates and recovery {#updates-and-recovery}

Check updates selects the most recently published `dsh-v…` release from the official repository, including previews. Download and build uses an isolated source directory and the bundled tools; the existing service may keep running. An unsupported Node requirement or different pnpm version blocks preparation and requires a launcher/toolchain update. The prepared version becomes selectable only after dependency installation, build, frontend presence and CLI checks succeed.

Switching requires confirmation, stops the service, copies the private DSH data directory into `backups/`, and records the new active version before startup. A durable recovery marker prevents unattended startup after an interrupted switch. Successful startup clears the marker. A failed startup retains the new version, previous program and data backup; Retry current version starts the same version again. Each backup includes `recovery.json` identifying the previous and target versions. The launcher does not automatically downgrade sessions or restore backups because the new program may already have migrated data. Manual restoration requires a stopped service and coordinated restoration of both the old program selection and its matching data backup.

Failed downloads and builds retain their staging directories for diagnosis. Old versions and backups are not automatically deleted. Remove unused copies manually only while the service is stopped and after confirming which version and backup are needed. Git updates never change the developer's source checkout or the custom launcher's files.

## Development and checks {#development-and-checks}

```sh
npm run check
npm run test:ui
npm run test:import
npm run test:runtime
npm run test:desktop
npm run test:occupied
npm run test:update
```

The independent lint and unit checks run through `npm run check`. The desktop-launcher reusable workflow runs checks, import smoke, kit export and a real current-source build/start/restart check on Windows and macOS. PR CI calls it and includes its result in `all checks passed`; every master push also triggers it, including upstream-only changes. Its manual Windows installer option runs the complete build. `npm run test:source` requires root dependencies and `pnpm run build`, then validates the real CLI announcement, authenticated page access and restart using isolated data and OS-assigned ports; it makes no model request and retains redacted failure logs under `.cache/test-results/source-*/`. Tool versions and checksums live in `toolchain.json`; pnpm follows the source manifest. `node scripts/size-report.mjs` measures an existing payload without deleting dependencies.

The import smoke exercises the management button and IPC with a fixture directory and confirmed test dialogs, checks imported files and the retained backup, and captures the management window. The native directory picker itself requires manual verification. Tests print TAP failure details as each case finishes. Process fixtures read complete marked PID records from stdout and ignore stderr diagnostics. Service fixtures await process shutdown before deleting their temporary runtime directories. The Node tests exercise import replacement, copy rejection, failed commits and interrupted recovery, settings validation, release admission, process cancellation, descendant cleanup and interrupted update recovery. The Electron smoke opens the actual management window with a separate test data directory, validates its rendered text, and writes `.cache/test-results/management.png`. It does not call a model or establish full DSH compatibility. The runtime smoke excludes developer tools from PATH and exercises two real service starts, HTTP page requests and stops. The desktop smoke opens the real DSH page in Electron and writes `.cache/test-results/workspace.png`. The update smoke downloads a fixed official release, builds it, backs up a test marker, switches versions and starts the service in dedicated test state; it needs network access, extra time and disk space. Runtime preparation and packaging are separate checks; a management-window smoke does not certify an offline installation or a real version upgrade.

## Limitations {#limitations}

The management interface is Chinese. Intel Mac packaging, proxy authentication, automatic launcher updates, disk-space estimation and automatic backup retention are not supplied. The workspace renderer denies permission prompts, so microphone input and other permission-gated browser features are unavailable. The first payload contains development dependencies to support the existing DSH source launcher and therefore produces a large installer. Future source builds can require additional native compilers or new bundled tool versions. A runtime build may run trusted upstream lifecycle scripts. Release availability depends on GitHub connectivity and rate limits. Start and restart wait up to two minutes for the CLI's authenticated readiness announcement; third-party changes to that announcement require launcher adaptation.
