# Bootstrap and build in this extracted directory; no global Node/Git/pnpm installation is changed.
param([switch]$ResumePackaging)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$kit = $PSScriptRoot
$launcher = Join-Path $kit 'desktop-launcher'
$cache = Join-Path $launcher '.cache'
$log = Join-Path $kit 'build-windows.log'
New-Item -ItemType Directory -Force -Path $cache | Out-Null
Start-Transcript -Path $log -Force | Out-Null
$lockStream = $null
$exitCode = 1
function Run-Checked([string]$Binary, [string[]]$Arguments) {
    & $Binary @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed (exit $LASTEXITCODE): $Binary $($Arguments -join ' ')" }
}
function Download-Checked([string]$Url, [string]$Destination, [string]$Sha256) {
    if (-not (Test-Path -LiteralPath $Destination)) {
        Run-Checked (Join-Path $env:SystemRoot 'System32\curl.exe') @('--fail', '--location', '--retry', '2', '--connect-timeout', '30', '--max-time', '1800', '--output', "$Destination.part", $Url)
        Move-Item -LiteralPath "$Destination.part" -Destination $Destination -Force
    }
    if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Sha256) {
        throw "Checksum mismatch. Remove this cached archive and retry: $Destination"
    }
}
function Run-Smoke([string]$App, [string[]]$Arguments, [string]$Marker, [string]$Name) {
    $out = Join-Path $cache "$Name.stdout.log"
    $err = Join-Path $cache "$Name.stderr.log"
    $child = Start-Process -FilePath $App -ArgumentList $Arguments -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    if (-not $child.WaitForExit(600000)) {
        & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $child.Id /T /F
        if (-not $child.WaitForExit(15000)) { throw "Could not confirm termination: $Name" }
        throw "Packaged smoke timed out: $Name"
    }
    $child.Refresh()
    $markerFound = [bool](Select-String -LiteralPath $out -SimpleMatch $Marker -Quiet)
    # Windows PowerShell 5.1 exposes no ExitCode for a Start-Process -PassThru child, so the smoke's
    # own success marker is authoritative; a known nonzero exit code still fails.
    if (-not $markerFound -or ($null -ne $child.ExitCode -and $child.ExitCode -ne 0)) {
        throw "Packaged smoke failed: $Name. exitCode=$($child.ExitCode) markerFound=$markerFound See $out and $err"
    }
}
try {
    $lockStream = [System.IO.File]::Open((Join-Path $cache 'windows-build.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    if (-not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { throw 'This build kit targets Intel/AMD x64 Windows, not Windows ARM64.' }
    if ($kit.StartsWith('\\')) { throw 'Extract the kit to a local drive, not a network share.' }
    $success = Join-Path $kit 'BUILD-SUCCESS.txt'
    if (Test-Path -LiteralPath $success) { Remove-Item -LiteralPath $success }
    # Optional proxy is local to this build process and inherited children.
    $proxyFile = Join-Path $kit 'proxy.txt'
    if (Test-Path -LiteralPath $proxyFile) {
        $proxy = [System.IO.File]::ReadAllText($proxyFile).Trim()
        if ($proxy) {
            $uri = [Uri]$proxy
            if ($uri.Scheme -notin @('http', 'https') -or $uri.UserInfo -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment) { throw 'proxy.txt must contain an HTTP/HTTPS proxy without credentials or extra paths.' }
            $env:HTTP_PROXY = $proxy; $env:HTTPS_PROXY = $proxy
            $env:npm_config_proxy = $proxy; $env:npm_config_https_proxy = $proxy
        }
    }
    $pins = Get-Content -LiteralPath (Join-Path $launcher 'toolchain.json') -Raw | ConvertFrom-Json
    $nodeVersion = $pins.nodeVersion
    Write-Host "1/7 Preparing private Node.js $nodeVersion (no system installation changes)..."
    $archive = Join-Path $cache "node-v$nodeVersion-win-x64.zip"
    Download-Checked "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip" $archive $pins.windowsNodeSha256
    $bootstrap = Join-Path $cache 'bootstrap'
    New-Item -ItemType Directory -Force -Path $bootstrap | Out-Null
    Run-Checked (Join-Path $env:SystemRoot 'System32\tar.exe') @('-xf', $archive, '-C', $bootstrap)
    $nodeHome = Join-Path $bootstrap "node-v$nodeVersion-win-x64"
    $node = Join-Path $nodeHome 'node.exe'
    $npm = Join-Path $nodeHome 'node_modules\npm\bin\npm-cli.js'
    $env:PATH = "$nodeHome;$env:PATH"
    $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
    $env:ELECTRON_BUILDER_CACHE = Join-Path $cache 'electron-builder'
    $env:ELECTRON_CACHE = Join-Path $cache 'electron'
    $env:CI = 'true'
    $env:ELECTRON_GET_USE_PROXY = '1'
    $env:ELECTRON_INSTALL_PLATFORM = 'win32'
    $env:ELECTRON_INSTALL_ARCH = 'x64'
    Remove-Item Env:ELECTRON_OVERRIDE_DIST_PATH -ErrorAction SilentlyContinue
    Set-Location -LiteralPath $launcher
    Write-Host '2/7 Installing launcher build dependencies...'
    if ($ResumePackaging) {
        if (-not (Test-Path -LiteralPath (Join-Path $launcher 'node_modules/electron/install.js'))) { throw 'Missing build dependencies. Run Build-Windows.cmd first.' }
        Run-Checked $node @('scripts/build-state.mjs')
        Run-Checked $node @('scripts/verify-payload.mjs', 'win32')
        Write-Host 'Reusing installed dependencies and the completed payload.'
    } else {
        Run-Checked $node @($npm, 'ci', '--registry=https://registry.npmjs.org', '--cache', (Join-Path $cache 'npm'))
    }
    Write-Host 'Preparing Electron executable (downloads only when missing)...'
    Run-Checked $node @('node_modules/electron/install.js')
    if (-not (Test-Path -LiteralPath (Join-Path $launcher 'node_modules/electron/dist/electron.exe'))) { throw 'Electron installation did not produce electron.exe.' }
    Write-Host '3/7 Running Windows lifecycle and data tests...'
    Run-Checked $node @($npm, 'run', 'check')
    Write-Host '4/7 Building offline DSH payload (this can take a while)...'
    if ($ResumePackaging) { Write-Host 'Reusing completed payload; source build skipped.' }
    else { Run-Checked $node @('scripts/prepare-windows.mjs') }
    Write-Host '5/7 Testing the bundled tools and service without developer tools on PATH...'
    Run-Checked $node @('scripts/smoke-runtime.mjs')
    Write-Host '6/7 Creating the unsigned installer...'
    Run-Checked $node @($npm, 'run', 'package:win')
    Write-Host '7/7 Testing the packaged application, occupied port and data import...'
    $app = Join-Path $cache 'dist\win-unpacked\DSH Launcher.exe'
    Run-Smoke $app @('--smoke-workspace', '--smoke-occupied') 'ELECTRON_OCCUPIED_PORT_SMOKE_OK' 'packaged-port'
    Run-Smoke $app @('--smoke', '--smoke-import') 'LAUNCHER_IMPORT_SMOKE_OK' 'packaged-import'
    $package = Get-Content -LiteralPath (Join-Path $launcher 'package.json') -Raw | ConvertFrom-Json
    $installer = Join-Path $cache "dist\DSH-Launcher-$($package.version)-Windows-x64-Setup.exe"
    if (-not (Test-Path -LiteralPath $installer)) { throw "Expected installer missing: $installer" }
    $hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    "Installer: $installer`r`nSHA256: $hash`r`nUnsigned Windows x64; runtime and packaged smoke checks passed." | Set-Content -LiteralPath $success -Encoding UTF8
    Write-Host "SUCCESS: $installer" -ForegroundColor Green
    Write-Host "SHA256: $hash"
    Write-Host 'The build does not install the app. Run the resulting Setup.exe to install it.'
    $exitCode = 0
} catch {
    Write-Host "BUILD FAILED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host $_.InvocationInfo.PositionMessage
    Write-Host $_.ScriptStackTrace
    Write-Host "Log: $log"
    Write-Host 'Keep this folder and the logs. No success record is produced on failure.'
} finally {
    if ($null -ne $lockStream) { $lockStream.Dispose() }
    Stop-Transcript | Out-Null
}
exit $exitCode
