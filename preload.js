const { contextBridge, ipcRenderer } = require('electron');

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

// Expose secure API to renderer
contextBridge.exposeInMainWorld('api', {
  // Library & Config API
  library: {
    getConfig: () => ipcRenderer.invoke('config:get'),
    saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
    selectDirectory: (defaultPath) => ipcRenderer.invoke('dialog:select-directory', defaultPath),
    selectImage: () => ipcRenderer.invoke('dialog:select-image'),
    getTracks: () => ipcRenderer.invoke('library:get-tracks'),
    getAlbums: () => ipcRenderer.invoke('library:get-albums'),
    addAlbumFolder: (folderPath) => ipcRenderer.invoke('library:add-album-folder', folderPath),
    updateAlbum: (albumData) => ipcRenderer.invoke('library:update-album', albumData),
    updateTrack: (trackData) => ipcRenderer.invoke('library:update-track', trackData),
    deleteAlbum: (albumId, deleteFromDisk = true) => ipcRenderer.invoke('library:delete-album', albumId, deleteFromDisk),
    getPlaylists: () => ipcRenderer.invoke('library:get-playlists'),
    createPlaylist: (name, trackIds) => ipcRenderer.invoke('library:create-playlist', name, trackIds),
    setPlaylistTracks: (id, trackIds) => ipcRenderer.invoke('library:set-playlist-tracks', id, trackIds),
    deletePlaylist: (id) => ipcRenderer.invoke('library:delete-playlist', id),
    renamePlaylist: (id, name) => ipcRenderer.invoke('library:rename-playlist', id, name),
    addTrackToPlaylist: (playlistId, trackId) => ipcRenderer.invoke('library:add-to-playlist', playlistId, trackId),
    removeTrackFromPlaylist: (playlistId, trackId) => ipcRenderer.invoke('library:remove-from-playlist', playlistId, trackId),
    scanFolders: () => ipcRenderer.invoke('library:scan-folders'),
    toggleLike: (trackId) => ipcRenderer.invoke('library:toggle-like', trackId),
    deleteTrack: (trackId, deleteFile = true) => ipcRenderer.invoke('library:delete-track', trackId, deleteFile),
    onScanProgress: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('library:scan-progress', handler);
      return () => ipcRenderer.removeListener('library:scan-progress', handler);
    },
    findCovers: () => ipcRenderer.invoke('library:find-covers'),
    onCoversProgress: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('library:covers-progress', handler);
      return () => ipcRenderer.removeListener('library:covers-progress', handler);
    },
    // Library changed in the main process (download finished, covers found ...)
    onUpdated: (callback) => {
      const handler = () => callback();
      ipcRenderer.on('library:tracks-updated', handler);
      return () => ipcRenderer.removeListener('library:tracks-updated', handler);
    }
  },

  // Shell & App Control API
  app: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    openPath: (p) => ipcRenderer.invoke('shell:open-path', p),
    openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
    showItemInFolder: (p) => ipcRenderer.invoke('shell:show-item-in-folder', p)
  },

  // Soundcloud & Services Helpers
  services: {
    getSoundcloudPluginPath: (name) => ipcRenderer.invoke('services:get-sc-plugin', name),
    getSoundcloudThemePath: (name) => ipcRenderer.invoke('services:get-sc-theme', name),
    getSoundcloudBridge: () => ipcRenderer.invoke('services:get-soundcloud-bridge'),
    getYandexStyle: () => ipcRenderer.invoke('services:get-yandex-style'),
    getYandexBridge: () => ipcRenderer.invoke('services:get-yandex-bridge')
  },

  // SoundCloud Downloader API
  soundcloud: {
    downloadTrack: (trackData) => ipcRenderer.invoke('soundcloud:download-current', trackData),
    downloadByUrl: (url) => ipcRenderer.invoke('soundcloud:download-url', url),
    onDownloadProgress: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('soundcloud:download-progress', handler);
      return () => ipcRenderer.removeListener('soundcloud:download-progress', handler);
    }
  },

  // Proxy Control API
  proxy: {
    setServiceProxy: (service, config) => ipcRenderer.invoke('proxy:set-proxy', { service, ...config }),
    testProxy: (config) => ipcRenderer.invoke('proxy:test-proxy', config),
    getActiveIp: (service) => ipcRenderer.invoke('proxy:get-active-ip', service)
  },

  // Network music storage (WebDAV)
  remote: {
    test: (form) => ipcRenderer.invoke('remote:test', form),
    connect: (form) => ipcRenderer.invoke('remote:connect', form),
    disconnect: () => ipcRenderer.invoke('remote:disconnect'),
    status: () => ipcRenderer.invoke('remote:status')
  },

  // Accent color extracted from artwork
  color: {
    fromCover: (src) => ipcRenderer.invoke('color:from-cover', src)
  },

  // Lyrics API (LRCLIB)
  lyrics: {
    get: (query) => ipcRenderer.invoke('lyrics:get', query)
  },

  // Mini-Player Overlay API
  overlay: {
    updateTrack: (data) => ipcRenderer.send('overlay:update-track', data),
    onControl: (callback) => {
      const handler = (_event, action) => callback(action);
      ipcRenderer.on('overlay:control', handler);
      return () => ipcRenderer.removeListener('overlay:control', handler);
    },
    getDisplays: () => ipcRenderer.invoke('overlay:get-displays'),
    preview: () => ipcRenderer.send('overlay:preview'),
    onDisplaysChanged: (callback) => {
      const handler = () => callback();
      ipcRenderer.on('overlay:displays-changed', handler);
      return () => ipcRenderer.removeListener('overlay:displays-changed', handler);
    }
  }
});
