/** Render only structured state and text; release notes and process output are never HTML. */
import { zh as copy } from './copy.mjs';
const $ = id => document.getElementById(id);
for (const element of document.querySelectorAll('[data-copy]')) element.textContent = copy[element.dataset.copy];
let dirty = false, previousSettings = '', currentState;
const tabs = [...document.querySelectorAll('[data-tab]')];
function selectTab(tab) {
  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
    $('panel-' + item.dataset.tab).hidden = !selected;
  }
}
for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', event => {
    const index = tabs.indexOf(tab);
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault(); selectTab(tabs[next]); tabs[next].focus();
  });
}
function formSettings() {
  return { port: Number($('port').value), proxy: $('proxy').value,
    proxyUpdates: $('proxyUpdates').checked, proxyService: $('proxyService').checked, proxyBrowser: $('proxyBrowser').checked };
}
function renderDirty() {
  $('dirty').dataset.dirty = String(dirty);
  $('dirty').textContent = dirty ? copy.unsaved : copy.settingsClean;
  $('resetSettings').disabled = !dirty || currentState?.busy;
  $('settings').querySelector('button[type=submit]').disabled = !dirty || currentState?.busy;
  document.querySelector('[data-action=testProxy]').disabled = dirty || currentState?.busy;
}
$('resetSettings').addEventListener('click', () => {
  dirty = false; previousSettings = ''; render(currentState);
});
function render(next) {
  currentState = next;
  document.querySelector('.hero').dataset.status = next.failure ? 'error' : next.busy ? 'busy' : next.running ? 'running' : 'idle';
  $('port').disabled = next.running || next.busy;
  document.querySelector('[data-action=start]').classList.toggle('primary', !next.running);
  document.querySelector('[data-action=open]').classList.toggle('primary', next.running);
  $('defaultData').textContent = (next.defaultData?.available ? copy.importFound : copy.importMissing) + (next.defaultData?.path || '~/.dsh');
  $('phase').textContent = copy.phase[next.phase] || next.phase;
  $('version').textContent = next.active ? copy.version + next.active.version : copy.noVersion;
  $('actualPort').textContent = next.actualPort ? copy.actualPort + next.actualPort + (next.actualPort !== next.settings.port ? copy.autoPort : '') : '';
  $('latest').textContent = next.latest ? copy.latest + next.latest.version : copy.noRelease;
  document.querySelector('[data-action=activate]').textContent = next.prepared ? copy.activate + ' ' + next.prepared.version : copy.activate;
  $('notes').textContent = next.latest?.notes || '';
  $('logs').textContent = (next.logs || []).join('\n');
  $('logs').scrollTop = $('logs').scrollHeight;
  if (next.failure) $('notice').textContent = (copy.errors[next.failure] || copy.errors.unexpected) + (next.failurePath ? '\n' + next.failurePath : '');
  $('retry').hidden = !next.recoveryRequired;
  for (const button of document.querySelectorAll('[data-action]')) {
    const action = button.dataset.action;
    button.disabled = next.busy && !['data', 'release', 'cancel'].includes(action);
    if (action === 'importDefault') button.disabled = next.busy || !next.defaultData?.available || next.recoveryRequired;
    if (action === 'importDirectory') button.disabled = next.busy || next.recoveryRequired;
    if (action === 'open') button.disabled = !next.running || next.busy;
    if (['stop', 'restart'].includes(action)) button.disabled = !next.running || next.busy;
    if (action === 'start') button.disabled = next.running || next.busy || next.recoveryRequired;
    if (action === 'prepare') button.disabled = !next.latest || next.busy || next.latest.version === next.active?.version;
    if (action === 'activate') button.disabled = !next.prepared || next.busy;
    if (action === 'start') button.hidden = next.running;
    if (['stop', 'restart'].includes(action)) button.hidden = !next.running;
    if (action === 'cancel') button.hidden = !['fetching', 'building'].includes(next.phase) || !next.busy;
    if (action === 'cancel') button.disabled = !['fetching', 'building'].includes(next.phase) || !next.busy;
  }
  const serialized = JSON.stringify(next.settings);
  if (!dirty && serialized !== previousSettings) {
    for (const [key, value] of Object.entries(next.settings)) {
      if (typeof value === 'boolean') $(key).checked = value; else $(key).value = value;
    }
    previousSettings = serialized;
  }
  renderDirty();
}
async function invoke(action, value) {
  $('notice').textContent = '';
  try {
    const result = await window.launcher.invoke(action, value);
    if (!result.ok) { $('notice').textContent = (copy.errors[result.code] || copy.errors.unexpected) + (result.path ? '\n' + result.path : ''); return; }
    if (action === 'settings') { dirty = false; $('notice').textContent = copy.saved; }
    if (result.value?.imported) $('notice').textContent = copy.imported;
    if (action === 'testProxy') $('notice').textContent = copy.connected;
    const snapshot = await window.launcher.invoke('state');
    if (snapshot.ok) render(snapshot.value);
  } catch { $('notice').textContent = copy.errors.unexpected; }
}
for (const button of document.querySelectorAll('[data-action]')) button.addEventListener('click', () => void invoke(button.dataset.action));
$('settings').addEventListener('input', () => {
  const values = formSettings();
  dirty = Object.entries(currentState.settings).some(([key, value]) => values[key] !== value);
  renderDirty();
});
$('settings').addEventListener('submit', event => {
  event.preventDefault();
  void invoke('settings', formSettings());
});
window.launcher.subscribe(render);
const initial = await window.launcher.invoke('state');
if (initial.ok) render(initial.value);
