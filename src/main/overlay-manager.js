const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');

const OVERLAY_WIDTH = 300;
const OVERLAY_HEIGHT = 84;
const MARGIN = 16;

let overlayWindow = null;
let mainWindowRef = null;
let configStoreRef = null;
let lastTrackData = null;

function getOverlaySettings() {
  const settings = (configStoreRef && configStoreRef.get('settings')) || {};
  const overlay = settings.overlay || {};
  return {
    enabled: !!overlay.enabled,
    position: overlay.position || 'bottom-right',
    // 'primary', 'app' (the monitor the main window is on) or a display id
    display: overlay.display == null ? 'primary' : String(overlay.display)
  };
}

function resolveDisplay(choice) {
  if (choice === 'app' && mainWindowRef && !mainWindowRef.isDestroyed()) {
    // getNormalBounds: a minimized window still reports where it will be restored
    return screen.getDisplayMatching(mainWindowRef.getNormalBounds());
  }
  if (choice !== 'primary' && choice !== 'app') {
    const found = screen.getAllDisplays().find(d => String(d.id) === choice);
    if (found) return found;
  }
  // unplugged monitor or 'primary'
  return screen.getPrimaryDisplay();
}

function listDisplays() {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays()
    .slice()
    .sort((a, b) => (a.bounds.x - b.bounds.x) || (a.bounds.y - b.bounds.y))
    .map((d, i) => ({
      id: String(d.id),
      index: i + 1,
      label: d.label || '',
      width: Math.round(d.size.width * d.scaleFactor),
      height: Math.round(d.size.height * d.scaleFactor),
      primary: d.id === primaryId
    }));
}

function computePosition(position) {
  const display = resolveDisplay(getOverlaySettings().display);
  const { x: ax, y: ay, width, height } = display.workArea;

  switch (position) {
    case 'top-left':
      return { x: ax + MARGIN, y: ay + MARGIN };
    case 'top-right':
      return { x: ax + width - OVERLAY_WIDTH - MARGIN, y: ay + MARGIN };
    case 'bottom-left':
      return { x: ax + MARGIN, y: ay + height - OVERLAY_HEIGHT - MARGIN };
    case 'bottom-right':
    default:
      return { x: ax + width - OVERLAY_WIDTH - MARGIN, y: ay + height - OVERLAY_HEIGHT - MARGIN };
  }
}

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;

  overlayWindow = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', '..', 'overlay-preload.js')
    }
  });

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));

  overlayWindow.webContents.on('did-finish-load', () => {
    if (lastTrackData && overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('overlay:track-data', lastTrackData);
    }
  });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });

  return overlayWindow;
}

function showOverlay() {
  const { enabled, position } = getOverlaySettings();
  if (!enabled) return;

  createOverlayWindow();
  const { x, y } = computePosition(position);
  overlayWindow.setPosition(x, y);
  overlayWindow.showInactive();
}

function hideOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.hide();
  }
}

function destroyOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close();
  }
  overlayWindow = null;
}

function repositionIfVisible() {
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
    const { position } = getOverlaySettings();
    const { x, y } = computePosition(position);
    overlayWindow.setPosition(x, y);
  }
}

function onSettingsChanged() {
  const { enabled } = getOverlaySettings();
  if (!enabled) {
    hideOverlay();
  } else {
    repositionIfVisible();
  }
}

let previewTimer = null;

// Briefly show the mini player where it will appear, so the user sees the chosen monitor/corner
function previewOverlay() {
  const { enabled, position } = getOverlaySettings();
  if (!enabled) return;
  createOverlayWindow();
  const { x, y } = computePosition(position);
  overlayWindow.setPosition(x, y);
  overlayWindow.showInactive();
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    previewTimer = null;
    if (mainWindowRef && !mainWindowRef.isDestroyed() && !mainWindowRef.isMinimized()) hideOverlay();
  }, 2500);
}

function updateTrackData(data) {
  lastTrackData = data;
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay:track-data', data);
  }
}

function init(mainWindow, configStore) {
  mainWindowRef = mainWindow;
  configStoreRef = configStore;

  mainWindow.on('minimize', () => showOverlay());
  mainWindow.on('restore', () => hideOverlay());
  mainWindow.on('closed', () => destroyOverlay());

  ipcMain.on('overlay:update-track', (_event, data) => {
    updateTrackData(data);
  });

  ipcMain.on('overlay:control', (_event, action) => {
    mainWindowRef?.webContents.send('overlay:control', action);
  });

  ipcMain.handle('overlay:get-displays', () => listDisplays());
  ipcMain.on('overlay:preview', () => previewOverlay());

  const onDisplaysChanged = () => {
    repositionIfVisible();
    if (mainWindowRef && !mainWindowRef.isDestroyed()) mainWindowRef.webContents.send('overlay:displays-changed');
  };
  screen.on('display-added', onDisplaysChanged);
  screen.on('display-removed', onDisplaysChanged);
  screen.on('display-metrics-changed', onDisplaysChanged);

  ipcMain.on('overlay:restore-main', () => {
    const win = mainWindowRef;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
    hideOverlay();
  });
}

module.exports = {
  init,
  showOverlay,
  hideOverlay,
  destroyOverlay,
  onSettingsChanged
};
