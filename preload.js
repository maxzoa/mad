const { contextBridge, ipcRenderer } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function getAppFolder() {
  if (process.defaultApp) {
    return __dirname;
  }

  const candidates = [
    process.env.PORTABLE_EXECUTABLE_DIR,
    process.cwd(),
    path.dirname(process.execPath),
    process.resourcesPath
  ].filter(Boolean);

  return candidates.find((dir) => {
    const templatesDir = path.join(dir, 'templates');
    if (!fs.existsSync(templatesDir)) return false;
    return fs.readdirSync(templatesDir).some((fileName) => {
      const lower = fileName.toLowerCase();
      return lower !== 'logo.png' && ['.png', '.jpg', '.jpeg', '.webp', '.bmp'].includes(path.extname(lower));
    });
  }) || candidates[0];
}

contextBridge.exposeInMainWorld('desktopAPI', {
  assetUrl: (assetPath) => {
    const normalized = String(assetPath || '').replace(/^[.\\/]+/, '');
    return pathToFileURL(path.join(getAppFolder(), normalized)).href;
  },
  loadHistory: () => ipcRenderer.invoke('history:load'),
  saveHistory: (history) => ipcRenderer.invoke('history:save', history),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  importHistory: () => ipcRenderer.invoke('history:import'),
  exportHistoryZip: () => ipcRenderer.invoke('history:exportZip'),
  importHistoryZip: () => ipcRenderer.invoke('history:importZip'),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  listTemplates: () => ipcRenderer.invoke('templates:list'),
  checkDiagnostics: () => ipcRenderer.invoke('diagnostics:check'),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  openSavedMenusFolder: () => ipcRenderer.invoke('folder:openSavedMenus'),
  checkUpdates: () => ipcRenderer.invoke('updates:check'),
  installLatestUpdate: () => ipcRenderer.invoke('updates:installLatest'),
  installUpdate: (update) => ipcRenderer.invoke('updates:install', update),
  openUpdateDownload: (url) => ipcRenderer.invoke('updates:open', url),
  loadDraft: () => ipcRenderer.invoke('draft:load'),
  saveDraft: (draft) => ipcRenderer.invoke('draft:save', draft),
  clearDraft: () => ipcRenderer.invoke('draft:clear'),
  saveImage: (dataUrl, fileName) => ipcRenderer.invoke('image:save', { dataUrl, fileName })
});
