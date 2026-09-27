// SoundCloud webview preload: attaches the Music Hub bridge to the page's main world
// BEFORE SoundCloud's own scripts run. SoundCloud creates its <audio> elements detached
// from the DOM, so a bridge injected later (on dom-ready) can never find an element that
// already started playing — player state, volume and the equalizer would all be dead.
const { contextBridge, ipcRenderer } = require('electron');

try {
  const bridgeJs = ipcRenderer.sendSync('services:get-soundcloud-bridge-sync');
  if (bridgeJs) {
    contextBridge.executeInMainWorld({
      func: (code) => { (0, eval)(code); },
      args: [bridgeJs]
    });
  }
} catch (e) {
  console.warn('[SC Preload] Failed to attach bridge early:', e);
}
