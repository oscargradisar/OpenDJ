// Bridge between the sandboxed UI and the main process.
const { contextBridge, ipcRenderer, webUtils, webFrame } = require('electron');

contextBridge.exposeInMainWorld('cdj', {
  library: {
    list: () => ipcRenderer.invoke('library:list'),
    update: (id, patch) => ipcRenderer.invoke('library:update', id, patch),
    remove: (id, opts) => ipcRenderer.invoke('library:remove', id, opts),
    audioUrl: (id) => ipcRenderer.invoke('library:readAudio', id),
    readAudio: async (id) => {
      const url = await ipcRenderer.invoke('library:readAudio', id);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not read audio (HTTP ${response.status}).`);
      return response.arrayBuffer();
    },
    importDialog: () => ipcRenderer.invoke('library:importDialog'),
    importFiles: (files) =>
      ipcRenderer.invoke(
        'library:importPaths',
        Array.from(files).map((f) => webUtils.getPathForFile(f)).filter(Boolean),
      ),
    openFolder: () => ipcRenderer.invoke('library:openFolder'),
  },
  cc: {
    search: (query) => ipcRenderer.invoke('cc:search', query),
    download: (url, jobId) => ipcRenderer.invoke('cc:download', url, jobId),
    cancel: (jobId) => ipcRenderer.invoke('cc:cancel', jobId),
    onProgress: (fn) => {
      const handler = (_e, payload) => fn(payload);
      ipcRenderer.on('download:progress', handler);
      return () => ipcRenderer.removeListener('download:progress', handler);
    },
  },
  spotify: {
    hasKeys: () => ipcRenderer.invoke('spotify:hasKeys'),
    setKeys: (id, secret) => ipcRenderer.invoke('spotify:setKeys', id, secret),
    search: (query) => ipcRenderer.invoke('spotify:search', query),
    download: (result, jobId) => ipcRenderer.invoke('spotify:download', result, jobId),
  },
  ytdlp: {
    status: () => ipcRenderer.invoke('ytdlp:status'),
    update: () => ipcRenderer.invoke('ytdlp:update'),
  },
  stems: {
    status: (id) => ipcRenderer.invoke('stems:status', id),
    setup: () => ipcRenderer.invoke('stems:setup'),
    downloadModel: () => ipcRenderer.invoke('stems:downloadModel'),
    onModelProgress: (fn) => {
      const handler = (_e, payload) => fn(payload);
      ipcRenderer.on('stems:modelProgress', handler);
      return () => ipcRenderer.removeListener('stems:modelProgress', handler);
    },
    separate: (id, left, right) => ipcRenderer.invoke('stems:separate', id, left, right),
    read: (id, name) => ipcRenderer.invoke('stems:read', id, name),
    onProgress: (fn) => {
      const handler = (_e, payload) => fn(payload);
      ipcRenderer.on('stems:progress', handler);
      return () => ipcRenderer.removeListener('stems:progress', handler);
    },
  },
  video: {
    status: (id) => ipcRenderer.invoke('video:status', id),
    get: (id) => ipcRenderer.invoke('video:get', id),
    onProgress: (fn) => {
      const handler = (_e, payload) => fn(payload);
      ipcRenderer.on('video:progress', handler);
      return () => ipcRenderer.removeListener('video:progress', handler);
    },
  },
  toggleFullscreen: () => ipcRenderer.invoke('window:toggleFullscreen'),
  zoom: { get: () => webFrame.getZoomFactor(), set: (f) => webFrame.setZoomFactor(f) },
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
});
