/** Management-only IPC. Remote DSH pages never receive this preload. */
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('launcher', {
  invoke: (name, value) => ipcRenderer.invoke('launcher:action', name, value),
  subscribe: listener => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('launcher:state', handler);
    return () => ipcRenderer.removeListener('launcher:state', handler);
  },
});
