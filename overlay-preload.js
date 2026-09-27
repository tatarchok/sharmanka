const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayApi', {
  onTrackData: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('overlay:track-data', handler);
    return () => ipcRenderer.removeListener('overlay:track-data', handler);
  },
  sendControl: (action) => ipcRenderer.send('overlay:control', action),
  restoreMain: () => ipcRenderer.send('overlay:restore-main')
});
