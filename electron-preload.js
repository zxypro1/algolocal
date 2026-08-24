// electron-preload.js
const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  saveConfiguration: (configData) => ipcRenderer.invoke('save-config', configData),
  loadConfiguration: () => ipcRenderer.invoke('load-config'),
  setLanguage: (language) => ipcRenderer.invoke('set-language', language),
  setTheme: (theme) => ipcRenderer.invoke('set-theme', theme),

  // 页内查找。浏览器里 ⌘F 是白送的，Electron 得自己把
  // 菜单 -> 渲染进程 -> findInPage 这条链接起来。
  // 每个 on* 都返回取消订阅函数，组件卸载时要调用，否则热重载会越堆越多。
  onFindOpen: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('find:open', handler);
    return () => ipcRenderer.removeListener('find:open', handler);
  },
  onFindAgain: (callback) => {
    const handler = (_event, forward) => callback(forward);
    ipcRenderer.on('find:again', handler);
    return () => ipcRenderer.removeListener('find:again', handler);
  },
  onFindResult: (callback) => {
    const handler = (_event, result) => callback(result);
    ipcRenderer.on('find:result', handler);
    return () => ipcRenderer.removeListener('find:result', handler);
  },
  findInPage: (text, options) => ipcRenderer.invoke('find:query', text, options),
  stopFindInPage: () => ipcRenderer.invoke('find:stop')
});
