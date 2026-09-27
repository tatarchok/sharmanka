const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Tray,
  Menu,
  nativeImage,
  session,
  protocol,
  components
} = require('electron');
const path = require('path');
const fs = require('fs');

const ConfigStore = require('./src/main/config-store');
const LibraryManager = require('./src/main/library-manager');
const adBlockerManager = require('./src/main/adblocker');
const scDownloader = require('./src/main/sc-downloader');
const overlayManager = require('./src/main/overlay-manager');
const lyricsService = require('./src/main/lyrics');
const { accentFromCover } = require('./src/main/cover-color');
const { remoteStorage, RemoteStorage, isRemotePath, canonicalUrl, urlPath } = require('./src/main/remote-storage');

// Derive UA/Client-Hints from the actual bundled Chromium version instead of a hardcoded
// number. A spoofed version that doesn't match the real engine (visible to sites via
// navigator.userAgentData) is a classic bot-detection tell and can get sensitive requests
// like login rejected even though normal browsing still works.
const REAL_CHROME_VERSION = process.versions.chrome || '131.0.0.0';
const REAL_CHROME_MAJOR = REAL_CHROME_VERSION.split('.')[0];
const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${REAL_CHROME_VERSION} Safari/537.36`;

// Chromium switches for DRM, widevine, autoplay, and automation bypass
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('enable-features', 'EncryptedMediaExtensions,WidevineCdm');
app.commandLine.appendSwitch('no-sandbox');

// Register custom protocol for local artwork
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'atom',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

let mainWindow = null;
let tray = null;
let configStore = null;
let libraryManager = null;

function createWindow() {
  const iconPath = path.join(__dirname, 'icon.png');
  mainWindow = new BrowserWindow({
    title: 'Sharmanka',
    width: 1400,
    height: 860,
    minWidth: 1100,
    minHeight: 700,
    frame: false,
    backgroundColor: '#000000',
    icon: iconPath,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function setupProtocols() {
  protocol.registerFileProtocol('atom', (request, callback) => {
    const url = request.url.replace(/^atom:\/\/art\//, '');
    const decodedUrl = decodeURI(url);
    const artPath = path.join(app.getPath('userData'), 'album-art', decodedUrl);
    callback({ path: artPath });
  });
}

// Set default User-Agent fallback globally
app.userAgentFallback = CHROME_UA;

// Proxy Manager instance
const proxyManager = require('./src/main/proxy-manager');

async function setupSessions() {
  const applyUserAgentAndSecurity = (ses) => {
    ses.setUserAgent(CHROME_UA);
    
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      // Network music storage: the <audio> element cannot send credentials itself
      const remoteAuth = remoteStorage.authHeaderFor(details.url);
      if (remoteAuth) {
        details.requestHeaders['Authorization'] = remoteAuth;
        callback({ requestHeaders: details.requestHeaders });
        return;
      }
      details.requestHeaders['User-Agent'] = CHROME_UA;
      details.requestHeaders['sec-ch-ua'] = `"Chromium";v="${REAL_CHROME_MAJOR}", "Google Chrome";v="${REAL_CHROME_MAJOR}", "Not?A_Brand";v="99"`;
      details.requestHeaders['sec-ch-ua-mobile'] = '?0';
      details.requestHeaders['sec-ch-ua-platform'] = '"Windows"';
      callback({ requestHeaders: details.requestHeaders });
    });

    ses.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, callback) => {
      const responseHeaders = { ...details.responseHeaders };

      // Network music storage: allow the player (crossOrigin="anonymous", needed for the
      // equalizer's Web Audio graph) to read the audio stream
      if (remoteStorage.origin && details.url.startsWith(remoteStorage.origin)) {
        for (const key of Object.keys(responseHeaders)) {
          if (/^access-control-allow-(origin|credentials)$/i.test(key)) delete responseHeaders[key];
        }
        responseHeaders['Access-Control-Allow-Origin'] = ['*'];
        responseHeaders['Access-Control-Expose-Headers'] = ['Content-Length, Content-Range, Accept-Ranges'];
        callback({ responseHeaders });
        return;
      }
      // Remove CSP restrictions so custom styles and scripts can run smoothly
      delete responseHeaders['content-security-policy'];
      delete responseHeaders['content-security-policy-report-only'];

      // Only set CORS headers when an Origin is explicitly present in the request
      // and reflect that specific origin (never '*' when credentials are used)
      const origin = details.requestHeaders?.['Origin'] || details.requestHeaders?.['origin'];
      if (origin) {
        responseHeaders['access-control-allow-origin'] = [origin];
        responseHeaders['access-control-allow-credentials'] = ['true'];
        responseHeaders['access-control-allow-methods'] = ['GET, POST, OPTIONS, HEAD, PUT, DELETE, PATCH'];
        responseHeaders['access-control-allow-headers'] = ['*'];
      }

      callback({ responseHeaders });
    });

    ses.setPermissionCheckHandler((_webContents, _permission, _origin) => true);
    ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(true));
  };

  const scSession = session.fromPartition('persist:soundcloud');
  const ymSession = session.fromPartition('persist:yandexmusic');

  applyUserAgentAndSecurity(session.defaultSession);
  applyUserAgentAndSecurity(scSession);
  applyUserAgentAndSecurity(ymSession);

  scDownloader.setSession(scSession);

  // Apply saved proxy configurations
  const proxyCfg = configStore.get('proxy') || {};
  await Promise.allSettled([
    proxyManager.applySessionProxy(scSession, proxyCfg.soundcloud, 'soundcloud'),
    proxyManager.applySessionProxy(ymSession, proxyCfg.yandex, 'yandex')
  ]);

  // Enable adblocker across sessions
  adBlockerManager.initialize().then(() => {
    adBlockerManager.enableForSession(session.defaultSession);
    adBlockerManager.enableForSession(scSession);
    adBlockerManager.enableForSession(ymSession);
  });

  // Capture SoundCloud client_id from webview API requests
  scSession.webRequest.onBeforeRequest({ urls: ['*://*.soundcloud.com/*', '*://*.sndcdn.com/*'] }, (details, callback) => {
    try {
      if (details.url && details.url.includes('client_id=')) {
        const match = details.url.match(/client_id=([a-zA-Z0-9_-]{10,})/);
        if (match && match[1]) {
          scDownloader.setCapturedClientId(match[1]);
        }
      }
    } catch (e) {}
    callback({});
  });
}

// Global web-contents handler for popups and login windows
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    // Deny ad, promo, and upsell popups
    if (
      url.includes('soundcloud.com/go') ||
      url.includes('soundcloud.com/student') ||
      url.includes('soundcloud.com/pro') ||
      url.includes('soundcloud.com/checkout') ||
      url.includes('doubleclick') ||
      url.includes('adzerk') ||
      url.includes('adnxs')
    ) {
      return { action: 'deny' };
    }

    // Allow login and auth popups (Google, Apple, Facebook, Yandex, SoundCloud auth)
    if (
      url.includes('accounts.google.com') ||
      url.includes('appleid.apple.com') ||
      url.includes('facebook.com/v') ||
      url.includes('facebook.com/dialog') ||
      url.includes('passport.yandex') ||
      (url.includes('soundcloud.com') && (url.includes('/signin') || url.includes('/login') || url.includes('/oauth') || url.includes('/connect')))
    ) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 800,
          height: 700,
          autoHideMenuBar: true,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
          }
        }
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
});

function setupIpc() {
  // Proxy IPC
  ipcMain.handle('proxy:set-proxy', async (_event, proxyData) => {
    const { service, enabled, type, host, port, username, password, url } = proxyData;
    const currentCfg = configStore.get() || {};
    const proxyCfg = { ...(currentCfg.proxy || {}) };
    proxyCfg[service] = {
      enabled: !!enabled,
      type: type || 'socks5',
      host: (host || '').trim(),
      port: (port !== undefined && port !== null ? String(port) : '').trim(),
      username: (username || '').trim(),
      password: (password || '').trim(),
      url: (url || '').trim()
    };
    configStore.set('proxy', proxyCfg);

    let targetSession = null;
    if (service === 'soundcloud') targetSession = session.fromPartition('persist:soundcloud');
    else if (service === 'yandex') targetSession = session.fromPartition('persist:yandexmusic');

    if (targetSession) {
      await proxyManager.applySessionProxy(targetSession, proxyCfg[service], service);
    }

    return { success: true, proxy: proxyCfg[service] };
  });

  ipcMain.handle('proxy:test-proxy', async (_event, proxyConfig) => {
    return await proxyManager.testProxy(proxyConfig);
  });

  ipcMain.handle('proxy:get-active-ip', async (_event, service) => {
    let targetSession = null;
    if (service === 'soundcloud') targetSession = session.fromPartition('persist:soundcloud');
    else if (service === 'yandex') targetSession = session.fromPartition('persist:yandexmusic');
    else targetSession = session.defaultSession;

    try {
      const { net } = require('electron');
      const response = await net.fetch('https://api.ipify.org?format=json', {
        session: targetSession
      });
      const data = await response.json();
      return { success: true, ip: data.ip };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Config IPC
  ipcMain.handle('config:get', async () => {
    return configStore.get();
  });

  ipcMain.handle('config:save', async (_event, newConfig) => {
    configStore.save(newConfig);
    overlayManager.onSettingsChanged();
    return configStore.get();
  });

  // Dialog IPC
  ipcMain.handle('dialog:select-directory', async (_event, defaultPath) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: defaultPath || app.getPath('music')
    });
    if (!result.canceled && result.filePaths.length > 0) {
      return result.filePaths[0];
    }
    return null;
  });

  ipcMain.handle('dialog:select-image', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Выберите изображение',
      filters: [
        { name: 'Изображения (JPG, PNG, WebP, GIF)', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }
      ],
      properties: ['openFile']
    });
    if (!result.canceled && result.filePaths.length > 0) {
      return result.filePaths[0];
    }
    return null;
  });

  // Library IPC
  ipcMain.handle('library:get-tracks', async () => {
    return libraryManager.getTrackList();
  });

  ipcMain.handle('library:get-albums', async () => {
    return libraryManager.getAlbums();
  });

  ipcMain.handle('library:add-album-folder', async (_event, folderPath) => {
    return await libraryManager.addAlbumFromFolder(folderPath);
  });

  ipcMain.handle('library:update-album', async (_event, albumData) => {
    return await libraryManager.updateAlbum(albumData);
  });

  ipcMain.handle('library:update-track', async (_event, trackData) => {
    return await libraryManager.updateTrack(trackData);
  });

  ipcMain.handle('library:delete-album', async (_event, albumId, deleteFromDisk = true) => {
    return await libraryManager.deleteAlbum(albumId, deleteFromDisk);
  });

  ipcMain.handle('library:get-playlists', async () => {
    return libraryManager.getPlaylists();
  });

  ipcMain.handle('library:create-playlist', async (_event, name, trackIds) => {
    return libraryManager.createPlaylist(name, trackIds);
  });

  ipcMain.handle('library:set-playlist-tracks', async (_event, id, trackIds) => {
    return libraryManager.setPlaylistTracks(id, trackIds);
  });

  ipcMain.handle('library:delete-playlist', async (_event, id) => {
    return libraryManager.deletePlaylist(id);
  });

  ipcMain.handle('library:rename-playlist', async (_event, id, name) => {
    return libraryManager.renamePlaylist(id, name);
  });

  ipcMain.handle('library:add-to-playlist', async (_event, playlistId, trackId) => {
    return libraryManager.addTrackToPlaylist(playlistId, trackId);
  });

  ipcMain.handle('library:remove-from-playlist', async (_event, playlistId, trackId) => {
    return libraryManager.removeTrackFromPlaylist(playlistId, trackId);
  });

  // Online artwork for tracks/albums without covers; runs in the background after a scan
  const runCoverSearch = async () => {
    const result = await libraryManager.fetchMissingCovers((progress) => {
      mainWindow?.webContents.send('library:covers-progress', progress);
    });
    if (result && result.changed) {
      mainWindow?.webContents.send('library:tracks-updated');
    }
    mainWindow?.webContents.send('library:covers-progress', { finished: true, ...(result || {}) });
    return result;
  };

  ipcMain.handle('library:scan-folders', async () => {
    const tracks = await libraryManager.scanAllFolders((progress) => {
      mainWindow?.webContents.send('library:scan-progress', progress);
    });
    if ((configStore.get('library') || {}).autoCovers !== false) {
      runCoverSearch().catch(err => console.warn('Cover search failed:', err.message));
    }
    return tracks;
  });

  ipcMain.handle('library:find-covers', async () => {
    return await runCoverSearch();
  });

  ipcMain.handle('library:toggle-like', async (_event, trackId) => {
    return libraryManager.toggleLike(trackId);
  });

  ipcMain.handle('library:delete-track', async (_event, trackId, deleteFile = true) => {
    return libraryManager.deleteTrack(trackId, deleteFile);
  });

  // Network music storage (WebDAV) IPC
  const readRemoteForm = (form) => {
    const url = String(form?.url || '').trim();
    if (!isRemotePath(url)) throw new Error('Адрес должен начинаться с http:// или https://');
    const saved = (configStore.get('library') || {}).remote || {};
    const username = String(form?.username || '').trim();
    // Empty password field = keep the saved one (it is never sent back to the renderer)
    const password = form?.password ? String(form.password) : RemoteStorage.decryptPassword(saved.password);
    return { url: canonicalUrl(url), username, password };
  };

  ipcMain.handle('remote:test', async (_event, form) => {
    const { url, username, password } = readRemoteForm(form);
    return await remoteStorage.test({ url, username, password });
  });

  ipcMain.handle('remote:connect', async (_event, form) => {
    const { url, username, password } = readRemoteForm(form);
    const test = await remoteStorage.test({ url, username, password });

    const libraryConfig = configStore.get('library') || {};
    libraryConfig.remote = { url, username, password: RemoteStorage.encryptPassword(password) };
    libraryConfig.musicFolder = url;
    libraryConfig.folders = [url];
    configStore.set('library', libraryConfig);
    remoteStorage.configure(libraryConfig.remote);
    return { ...test, config: configStore.get() };
  });

  ipcMain.handle('remote:disconnect', async () => {
    const libraryConfig = configStore.get('library') || {};
    const wasRemote = isRemotePath(libraryConfig.musicFolder);
    delete libraryConfig.remote;
    if (wasRemote) {
      libraryConfig.musicFolder = '';
      libraryConfig.folders = (libraryConfig.folders || []).filter(f => !isRemotePath(f));
    }
    configStore.set('library', libraryConfig);
    remoteStorage.configure(null);
    return configStore.get();
  });

  ipcMain.handle('remote:status', async () => {
    const remote = (configStore.get('library') || {}).remote || {};
    return {
      url: remote.url || '',
      username: remote.username || '',
      hasPassword: !!remote.password,
      lastScanError: libraryManager.lastScanError || null
    };
  });

  // Interface accent color from the current artwork
  ipcMain.handle('color:from-cover', async (_event, src) => {
    return await accentFromCover(src, path.join(app.getPath('userData'), 'album-art'));
  });

  // Lyrics IPC (Now Playing view)
  ipcMain.handle('lyrics:get', async (_event, query) => {
    return await lyricsService.getLyrics(query || {});
  });

  // Shell IPC
  ipcMain.handle('shell:open-path', async (_event, targetPath) => {
    if (isRemotePath(targetPath)) return await shell.openExternal(targetPath);
    return await shell.openPath(targetPath);
  });

  ipcMain.handle('shell:open-external', async (_event, url) => {
    return await shell.openExternal(url);
  });

  ipcMain.handle('shell:show-item-in-folder', async (_event, targetPath) => {
    if (isRemotePath(targetPath)) {
      // Files on the server: open the containing folder in the browser (WebDAV servers list folders)
      const folderUrl = /\.[a-z0-9]{2,5}$/i.test(targetPath) ? urlPath.dirname(targetPath) : targetPath;
      await shell.openExternal(canonicalUrl(folderUrl, { dir: true }));
      return true;
    }
    shell.showItemInFolder(targetPath);
    return true;
  });

  // Window controls
  ipcMain.on('window:minimize', () => {
    mainWindow?.minimize();
  });

  ipcMain.on('window:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });

  ipcMain.on('window:close', () => {
    const cfg = configStore.get('settings');
    if (cfg?.minimizeToTray) {
      mainWindow?.hide();
    } else {
      app.quit();
    }
  });

  // Injected scripts and styles
  ipcMain.handle('services:get-sc-plugin', async (_event, filename) => {
    let filePath = path.join(__dirname, 'src', 'injected', 'soundcloud', 'plugins', filename);
    if (!fs.existsSync(filePath)) {
      filePath = path.join(__dirname, 'src', 'injected', 'soundcloud', 'themes', filename);
    }
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  });

  ipcMain.handle('services:get-sc-theme', async (_event, filename) => {
    const filePath = path.join(__dirname, 'src', 'injected', 'soundcloud', 'themes', filename);
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  });

  ipcMain.handle('services:get-soundcloud-bridge', async () => {
    const filePath = path.join(__dirname, 'src', 'injected', 'soundcloud', 'sc-bridge.js');
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  });

  // Sync variant for the SoundCloud webview preload, which must attach the bridge before page scripts run
  ipcMain.on('services:get-soundcloud-bridge-sync', (event) => {
    const filePath = path.join(__dirname, 'src', 'injected', 'soundcloud', 'sc-bridge.js');
    event.returnValue = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  });

  ipcMain.handle('services:get-yandex-style', async () => {
    const filePath = path.join(__dirname, 'src', 'injected', 'yandex', 'yandex.css');
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  });

  ipcMain.handle('services:get-yandex-bridge', async () => {
    const filePath = path.join(__dirname, 'src', 'injected', 'yandex', 'yandex-bridge.js');
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  });

  // Helper to ensure user specified a download destination
  const getTargetDownloadFolder = () => {
    const config = configStore.get('library') || {};
    const targetFolder = (config.musicFolder && typeof config.musicFolder === 'string' && config.musicFolder.trim()) ||
                         (Array.isArray(config.folders) && config.folders.find(f => f && typeof f === 'string' && f.trim()));
    if (targetFolder && isRemotePath(targetFolder)) {
      if (!remoteStorage.isConfigured()) {
        throw new Error('Сетевое хранилище не подключено. Проверьте настройки папки с музыкой.');
      }
      return targetFolder;
    }
    if (!targetFolder || !fs.existsSync(targetFolder)) {
      throw new Error('Папка для сохранения музыки не указана. Перейдите в Настройки и выберите папку для сохранения.');
    }
    return targetFolder;
  };

  // Runs a downloader into the library folder. For a network folder the files are downloaded
  // into a temporary local folder first and then uploaded to the server.
  const downloadIntoLibrary = async (label, runDownload) => {
    const targetFolder = getTargetDownloadFolder();
    const remoteRoot = isRemotePath(targetFolder) ? targetFolder : null;
    const localDir = remoteRoot
      ? fs.mkdtempSync(path.join(app.getPath('temp'), 'sharmanka-upload-'))
      : targetFolder;

    let result;
    try {
      result = await runDownload(localDir);
      if (remoteRoot) {
        await libraryManager.uploadLocalFolderToRemote(localDir, remoteRoot);
      }
    } finally {
      if (remoteRoot) {
        try { fs.rmSync(localDir, { recursive: true, force: true }); } catch (e) {}
      }
    }

    try {
      await libraryManager.scanAllFolders();
      mainWindow?.webContents.send('library:tracks-updated');
      mainWindow?.webContents.send('library:albums-updated');
    } catch (err) {
      console.warn(`Library refresh error after ${label} download:`, err);
    }
    return result;
  };

  // SoundCloud Downloader IPC
  ipcMain.handle('soundcloud:download-current', async (_event, trackData) => {
    const urlOrId = trackData?.permalink || trackData?.permalinkUrl || trackData?.url || trackData?.id;
    if (!urlOrId) {
      throw new Error('Не удалось определить ссылку на трек SoundCloud');
    }
    return downloadIntoLibrary('SoundCloud', (folder) => scDownloader.download(urlOrId, folder, (prog) => {
      mainWindow?.webContents.send('soundcloud:download-progress', prog);
    }));
  });

  ipcMain.handle('soundcloud:download-url', async (_event, url) => {
    if (!url) {
      throw new Error('Укажите ссылку на трек или альбом SoundCloud');
    }
    return downloadIntoLibrary('SoundCloud', (folder) => scDownloader.download(url, folder, (prog) => {
      mainWindow?.webContents.send('soundcloud:download-progress', prog);
    }));
  });
}

function setupTray() {
  const iconPath = path.join(__dirname, 'icon.png');
  if (!fs.existsSync(iconPath)) return;
  const rawIcon = nativeImage.createFromPath(iconPath);
  const trayIcon = rawIcon.resize({ width: 16, height: 16, quality: 'best' });
  tray = new Tray(trayIcon);
  tray.setToolTip('Sharmanka');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Показать Sharmanka',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      }
    },
    { type: 'separator' },
    {
      label: 'Выход',
      click: () => app.quit()
    }
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

// Set Windows App User Model ID for proper taskbar icon handling
if (process.platform === 'win32') {
  app.setAppUserModelId('com.sharmanka.app');
}

// App lifecycle
const appReadyPromise = components ? components.whenReady() : Promise.resolve();

app.whenReady()
  .then(() => appReadyPromise)
  .then(async () => {
    configStore = new ConfigStore();
    libraryManager = new LibraryManager(configStore);

    setupProtocols();
    await setupSessions();
    setupIpc();
    createWindow();
    setupTray();
    overlayManager.init(mainWindow, configStore);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

app.on('will-quit', () => {
  proxyManager.stopAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
