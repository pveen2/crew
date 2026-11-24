const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('crewHost', {
  platform: process.platform,
  ...(process.argv.includes('--crew-local-conductor') && {
    startConductor: () => ipcRenderer.invoke('crew:start-conductor'),
  }),
  conductorInfo: () => ipcRenderer.invoke('crew:info'),
  updateCheck: () => ipcRenderer.invoke('crew:update-check'),
  updateApply: () => ipcRenderer.invoke('crew:update-apply'),
  teamInfo: () => ipcRenderer.invoke('crew:team-info'),
  teamSet: (next) => ipcRenderer.invoke('crew:team-set', next),
  teamChooseFolder: () => ipcRenderer.invoke('crew:team-choose-folder'),
  teamCheck: () => ipcRenderer.invoke('crew:team-check'),
  teamApply: () => ipcRenderer.invoke('crew:team-apply'),
  openExternal: (url) => ipcRenderer.invoke('crew:open-external', url),
  /** Web links clicked anywhere in the app; returns an unsubscribe. */
  onOpenUrl: (cb) => {
    const listener = (_e, url) => cb(url);
    ipcRenderer.on('crew:open-url', listener);
    return () => ipcRenderer.removeListener('crew:open-url', listener);
  },
});
