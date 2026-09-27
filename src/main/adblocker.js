const { ElectronBlocker } = require('@cliqz/adblocker-electron');
const fetch = require('cross-fetch');

class AdBlockerManager {
  constructor() {
    this.blocker = null;
    this.isInitialized = false;
  }

  async initialize() {
    if (this.isInitialized) return;
    try {
      this.blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch);
      this.blocker.updateFromDiff({
        added: [
          // Whitelist critical auth, streaming, and CDN domains for services
          '@@||soundcloud.com^',
          '@@||sndcdn.com^',
          '@@||api-auth.soundcloud.com^',
          '@@||api.soundcloud.com^',
          '@@||api-v2.soundcloud.com^',
          '@@||passport.yandex.ru^',
          '@@||passport.yandex.com^',
          '@@||music.yandex.ru^',
          '@@||music.yandex.com^',
          '@@||yandex.ru^',
          '@@||yandex.com^',
          '@@||yastatic.net^'
        ]
      });
      this.isInitialized = true;
      console.log('AdBlocker initialized successfully');
    } catch (e) {
      console.warn('Failed to initialize AdBlocker:', e.message);
    }
  }

  enableForSession(targetSession) {
    if (this.blocker && targetSession) {
      try {
        this.blocker.enableBlockingInSession(targetSession);
      } catch (e) {
        console.warn('Failed to enable blocking in session:', e.message);
      }
    }
  }
}

module.exports = new AdBlockerManager();
