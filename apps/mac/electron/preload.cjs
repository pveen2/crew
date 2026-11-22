const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('crewHost', {
  platform: process.platform,
  conductorInfo: () => ipcRenderer.invoke('crew:info'),
  updateCheck: () => ipcRenderer.invoke('crew:update-check'),
  updateApply: () => ipcRenderer.invoke('crew:update-apply'),
});
