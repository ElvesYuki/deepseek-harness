/** Electron management window and isolated DSH window; only local management frames may invoke IPC. */
import { app, BrowserWindow, ipcMain, dialog, shell, session, Menu } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, appendFile, stat, rename, writeFile, mkdtemp, readFile, readdir, symlink } from 'node:fs/promises';
import { zh as copy } from '../ui/copy.mjs';
import { createServer } from 'node:net';
import { Manager } from './manager.mjs';
import { LauncherError, RELEASES, selectRelease, redact } from './core.mjs';

const base = dirname(dirname(fileURLToPath(import.meta.url)));
const page = pathToFileURL(join(base, 'ui/index.html')).href;
const smoke = process.argv.includes('--smoke');
const smokeWorkspace = process.argv.includes('--smoke-workspace');
const smokeRoot = app.isPackaged ? join(app.getPath('temp'), 'personal-dsh-launcher-smoke') : join(base, '.cache/test-results');
if (!['darwin', 'win32'].includes(process.platform)) { console.error('This launcher build supports macOS and Windows only.'); app.exit(1); }
if (smoke) app.setPath('userData', join(smokeRoot, 'smoke-data'));
if (smokeWorkspace) app.setPath('userData', join(smokeRoot, 'runtime'));
const owns = app.requestSingleInstanceLock();
let window, workspace, manager, quitting = false, allowedQuit = false, latest = null;
let logs = [], logQueue = Promise.resolve(), publishTimer;
const root = app.getPath('userData');
const payload = app.isPackaged ? join(process.resourcesPath, 'payload') : join(base, '.cache/payload');
const logFile = join(root, 'launcher.log');
function publish() {
  if (publishTimer) return;
  publishTimer = setTimeout(() => {
    publishTimer = undefined;
    if (window && !window.isDestroyed()) window.webContents.send('launcher:state', { ...manager.snapshot(), latest, logs });
  }, 80);
  publishTimer.unref();
}
function log(raw) {
  const line = redact(String(raw)).slice(-16000);
  logs = [...logs, line].slice(-300);
  logQueue = logQueue.then(async () => {
    const info = await stat(logFile).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info && info.size > 2 * 1024 * 1024) await rename(logFile, join(root, 'launcher.previous.log'));
    await appendFile(logFile, line + '\n', { mode: 0o600 });
  }).catch(error => { console.error('Launcher log unavailable:', error.code); });
  publish();
}
function secureWindow(target) {
  target.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  target.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  target.webContents.session.setPermissionCheckHandler(() => false);
}
async function applyProxy() {
  const settings = manager.settings;
  for (const [partition, enabled] of [['launcher-updates', settings.proxyUpdates], ['persist:dsh-workspace', settings.proxyBrowser]]) {
    const target = session.fromPartition(partition);
    await target.setProxy(settings.proxy && enabled
      ? { mode: 'fixed_servers', proxyRules: settings.proxy, proxyBypassRules: 'localhost;127.0.0.1;[::1]' }
      : { mode: 'direct' });
    await target.closeAllConnections();
  }
}
async function requestRelease() {
  const response = await session.fromPartition('launcher-updates').fetch(RELEASES, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'personal-dsh-launcher' },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new LauncherError('network', `GitHub HTTP ${response.status}`);
  return selectRelease(await response.json());
}
async function showWorkspace() {
  if (!manager.url) throw new LauncherError('start');
  if (!workspace || workspace.isDestroyed()) {
    workspace = new BrowserWindow({ width: 1360, height: 900, title: 'DeepSeek Harness',
      webPreferences: { partition: 'persist:dsh-workspace', sandbox: true, contextIsolation: true, nodeIntegration: false } });
    secureWindow(workspace);
    workspace.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== (manager.url ? new URL(manager.url).origin : null)) { event.preventDefault(); if (/^https?:\/\//.test(url)) void shell.openExternal(url); }
    });
    workspace.on('closed', () => { workspace = null; if (window && !window.isDestroyed()) window.show(); });
    workspace.webContents.on('render-process-gone', () => { log('Workspace renderer exited; reopen the workspace.'); });
  }
  const currentUrl = workspace.webContents.getURL();
  if (!currentUrl || new URL(currentUrl).origin !== new URL(manager.url).origin) await workspace.loadURL(manager.url);
  workspace.show(); workspace.focus();
}
async function confirmInterrupt() {
  const result = await dialog.showMessageBox(window, { type: 'warning', message: copy.interrupt,
    detail: copy.interruptDetail, buttons: [copy.cancelDialog, copy.continueDialog], defaultId: 0, cancelId: 0 });
  return result.response === 1;
}
function assertSender(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
    || event.senderFrame.url !== page) throw new LauncherError('sender');
}
async function action(name, value) {
  switch (name) {
    case 'state': return { ...manager.snapshot(), latest, logs };
    case 'data': await shell.openPath(root); return;
    case 'release': if (latest) await shell.openExternal(latest.url); return;
    case 'cancel': manager.controller?.abort(); return;
    case 'open': await showWorkspace(); return;
    default: return manager.exclusive(async signal => {
      switch (name) {
        case 'start': await manager.start(); await showWorkspace(); break;
        case 'retry': await manager.retry(); workspace?.destroy(); await showWorkspace(); break;
        case 'stop': if (await confirmInterrupt()) { await manager.stop(); workspace?.destroy(); } break;
        case 'restart': if (await confirmInterrupt()) { await manager.stop(); workspace?.destroy(); await manager.start(); await showWorkspace(); } break;
        case 'discoverData': await manager.discoverData(); break;
        case 'importDefault':
        case 'importDirectory': {
          let source;
          if (name === 'importDefault') {
            await manager.discoverData();
            if (!manager.defaultData.available) throw new LauncherError('importSource');
            source = manager.defaultData.path;
          } else {
            const chosen = await dialog.showOpenDialog(window, { title: copy.importDirectory, properties: ['openDirectory', 'showHiddenFiles'] });
            if (chosen.canceled || !chosen.filePaths.length) return { imported: false };
            source = chosen.filePaths[0];
          }
          const answer = await dialog.showMessageBox(window, { type: 'warning', message: copy.importConfirm,
            detail: source + '\n\n' + copy.importDetail, buttons: [copy.cancelDialog, copy.continueDialog], defaultId: 0, cancelId: 0 });
          if (answer.response !== 1) return { imported: false };
          await manager.importData(source);
          workspace?.destroy();
          try { await session.fromPartition('persist:dsh-workspace').clearStorageData(); }
          catch (cause) { throw new LauncherError('importBrowser', '', { cause }); }
          return { imported: true };
        }
        case 'settings': await manager.saveSettings(value); await applyProxy(); break;
        case 'check': latest = await requestRelease(); publish(); break;
        case 'testProxy': await requestRelease(); break;
        case 'prepare': if (!latest) throw new LauncherError('release'); await manager.prepareUpdate(latest, signal); break;
        case 'activate': if (await confirmInterrupt()) { workspace?.destroy(); await manager.activate(); await showWorkspace(); } break;
        default: throw new LauncherError('action');
      }
    });
  }
}
async function main() {
  await mkdir(root, { recursive: true, mode: 0o700 });
  manager = new Manager(root, payload, publish, log);
  window = new BrowserWindow({ width: 780, height: 660, minWidth: 620, minHeight: 560, title: 'DSH Launcher',
    backgroundColor: '#0b1120', webPreferences: { preload: join(base, 'src/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  secureWindow(window);
  window.webContents.on('will-navigate', (event, url) => { if (url !== page) event.preventDefault(); });
  ipcMain.handle('launcher:action', async (event, name, value) => {
    try { assertSender(event); return { ok: true, value: await action(name, value) }; }
    catch (error) { log(error.message); return { ok: false, code: error instanceof LauncherError ? error.code : 'unexpected', path: error instanceof LauncherError && error.code === 'importLinks' ? error.relativePath : undefined }; }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'DSH Launcher', submenu: [{ label: copy.manage, click: () => { if (window && !window.isDestroyed()) { window.show(); window.focus(); } } }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' }, { role: 'windowMenu' },
  ]));
  await window.loadFile(join(base, 'ui/index.html'));
  let initialized = false;
  try { await manager.initialize(); await applyProxy(); initialized = true; }
  catch (error) { manager.failure = error instanceof LauncherError ? error.code : 'unexpected'; publish(); }
  window.on('close', event => { if (!allowedQuit) { event.preventDefault(); app.quit(); } });
  if (smokeWorkspace) {
    const blocker = process.argv.includes('--smoke-occupied') ? createServer() : null;
    try {
      if (blocker) {
        await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen(0, '127.0.0.1', resolve); });
        await manager.saveSettings({ ...manager.settings, port: blocker.address().port });
      }
      await manager.exclusive(() => manager.start());
      if (blocker && manager.snapshot().actualPort === manager.settings.port) throw new Error('Occupied port was not replaced');
      await showWorkspace();
      const deadline = Date.now() + 60000;
      while (!await workspace.webContents.executeJavaScript("!document.querySelector('[data-dsh-boot]') && document.getElementById('root')?.innerText.length > 20 && !!document.querySelector('button')")) {
        if (Date.now() > deadline) throw new Error('DSH workspace did not render');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await workspace.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
      await new Promise(resolve => setTimeout(resolve, 300));
      await writeFile(join(smokeRoot, 'workspace.png'), (await workspace.webContents.capturePage()).toPNG());
      if (blocker) {
        const label = await window.webContents.executeJavaScript("document.getElementById('actualPort').textContent");
        if (!label.includes(String(manager.snapshot().actualPort))) throw new Error('Actual port is missing from management');
      }
      console.log(blocker ? 'ELECTRON_OCCUPIED_PORT_SMOKE_OK' : 'ELECTRON_WORKSPACE_SMOKE_OK');
    } finally { await manager.close(); if (blocker?.listening) await new Promise(resolve => blocker.close(resolve)); allowedQuit = true; app.quit(); }
    return;
  }
  if (smoke) {
    const compactChecks = await window.webContents.executeJavaScript(`(() => {
      const tabs = [...document.querySelectorAll('[data-tab]')];
      for (const tab of tabs) {
        tab.click();
        if (document.querySelectorAll('[role=tabpanel]:not([hidden])').length !== 1 || document.getElementById(tab.getAttribute('aria-controls')).hidden) return false;
      }
      tabs[0].click();
      const proxy = document.getElementById('proxy');
      const saved = proxy.value;
      proxy.value = 'http://127.0.0.1:9876';
      proxy.dispatchEvent(new Event('input', { bubbles: true }));
      if (!document.querySelector('[data-action=testProxy]').disabled || document.getElementById('resetSettings').disabled) return false;
      tabs[1].click(); tabs[0].click();
      if (proxy.value !== 'http://127.0.0.1:9876') return false;
      document.getElementById('resetSettings').click();
      if (proxy.value !== saved || !document.getElementById('resetSettings').disabled) return false;
      tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      if (tabs[1].getAttribute('aria-selected') !== 'true') return false;
      tabs[0].click(); tabs[0].focus();
      return document.documentElement.scrollWidth <= innerWidth;
    })()`);
    if (!compactChecks) throw new Error('Compact settings interaction failed');
    const fits = await window.webContents.executeJavaScript(`(() => {
      const save = document.querySelector('#settings button[type=submit]').getBoundingClientRect();
      return save.bottom <= innerHeight && save.right <= innerWidth;
    })()`);
    if (!fits) throw new Error('Default window clips settings actions');
    await mkdir(smokeRoot, { recursive: true });
    window.setSize(620, 560);
    const narrowFits = await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => {
      resolve(document.documentElement.scrollWidth <= innerWidth);
    }))`);
    if (!narrowFits) throw new Error('Minimum window has horizontal overflow');
    await writeFile(join(smokeRoot, 'management-compact.png'), (await window.webContents.capturePage()).toPNG());
    window.setSize(780, 660);
    await window.webContents.executeJavaScript('document.activeElement.blur()');
    if (process.argv.includes('--smoke-import')) {
      const source = await mkdtemp(join(smokeRoot, 'import-source-'));
      await mkdir(join(source, 'sessions'));
      await mkdir(join(source, 'profiles/node_modules'), { recursive: true });
      await symlink(join(source, 'missing-old-installation'), join(source, 'profiles/node_modules/old-package'), process.platform === 'win32' ? 'junction' : 'dir');
      await writeFile(join(source, 'sessions/smoke.jsonl'), 'import fixture');
      await mkdir(manager.paths.home, { recursive: true });
      await writeFile(join(manager.paths.home, 'before-import.txt'), 'previous fixture');
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      await window.webContents.executeJavaScript("document.querySelector('[data-tab=storage]').click(); document.querySelector('[data-action=importDirectory]').click()");
      const deadline = Date.now() + 15000;
      while (!await window.webContents.executeJavaScript("document.getElementById('notice').textContent.includes('数据已导入')")) {
        if (Date.now() > deadline) throw new Error('Import UI did not report completion');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (await readFile(join(manager.paths.home, 'sessions/smoke.jsonl'), 'utf8') !== 'import fixture') throw new Error('Imported file missing');
      const backups = await readdir(join(root, 'backups'));
      let retained = false;
      for (const backup of backups) {
        try { retained ||= await readFile(join(root, 'backups', backup, 'dsh-home/before-import.txt'), 'utf8') === 'previous fixture'; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (!retained || manager.service) throw new Error('Import did not retain backup or stop service');
      console.log('LAUNCHER_IMPORT_SMOKE_OK');
    }
    await new Promise(resolve => setTimeout(resolve, 800));
    await mkdir(smokeRoot, { recursive: true });
    await writeFile(join(smokeRoot, 'management.png'), (await window.webContents.capturePage()).toPNG());
    const text = await window.webContents.executeJavaScript('document.body.textContent');
    if (!text.includes('代理设置') || !text.includes('官方更新') || !text.includes('导入默认数据') || !text.includes('选择目录导入')) throw new Error('Management UI failed to render');
    console.log('LAUNCHER_UI_SMOKE_OK'); allowedQuit = true; app.quit(); return;
  }
  if (initialized && !manager.registry.recoveryRequired) {
    void manager.exclusive(async () => { await manager.start(); await showWorkspace(); }).catch(() => {});
  }
}
if (!owns) app.quit();
else {
  app.on('second-instance', () => { if (window && !window.isDestroyed()) { window.show(); window.focus(); } });
  app.on('before-quit', event => {
    if (allowedQuit) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void (async () => {
      if ((manager?.service || manager?.busy) && !await confirmInterrupt()) { quitting = false; return; }
      await manager?.close(); await logQueue; allowedQuit = true; app.quit();
    })().catch(error => { quitting = false; log(error.message); void dialog.showMessageBox(window, { type: 'error', message: copy.quitFailed }); });
  });
  app.whenReady().then(main).catch(error => { console.error(error); allowedQuit = true; app.exit(1); });
}
