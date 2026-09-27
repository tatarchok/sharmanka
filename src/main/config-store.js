const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class ConfigStore {
  constructor() {
    this.userDataPath = app.getPath('userData');
    this.configPath = path.join(this.userDataPath, 'config.json');
    this.defaults = {
      library: {
        musicFolder: '',
        folders: [],
        likedTrackIds: [],
        albums: [],
        playlists: []
      },
      settings: {
        theme: 'dark',
        discordRpc: true,
        minimizeToTray: false,
        activeTab: 'library',
        appearance: {
          accentColor: '#6366f1',
          bgImage: '',
          bgDim: 40,
          bgBlur: 10,
          bgAnimation: 'particles', // default for a fresh install; users can pick "Нет"
          bgAnimSensitivity: 100
        },
        equalizer: {
          enabled: true,
          preset: 'flat',
          gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        },
        overlay: {
          enabled: false,
          position: 'bottom-right'
        }
      },
      proxy: {
        soundcloud: { enabled: false, type: 'socks5', host: '', port: '', username: '', password: '', url: '' },
        yandex: { enabled: false, type: 'socks5', host: '', port: '', username: '', password: '', url: '' }
      },
      volume: 0.8,
      soundcloud: {
        theme: 'glassmorphism',
        customCss: '',
        customJs: ''
      },
      yandex: {
        customCssEnabled: true
      }
    };

    this.config = this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.configPath)) {
        // Look for existing config in other known appData directories (music-hub / sharmanka)
        try {
          const appData = app.getPath('appData');
          const candidates = [
            path.join(appData, 'music-hub', 'config.json'),
            path.join(appData, 'sharmanka', 'config.json')
          ];
          for (const cand of candidates) {
            if (cand !== this.configPath && fs.existsSync(cand)) {
              if (!fs.existsSync(this.userDataPath)) fs.mkdirSync(this.userDataPath, { recursive: true });
              fs.copyFileSync(cand, this.configPath);
              break;
            }
          }
        } catch (err) {}
      }

      if (!fs.existsSync(this.configPath)) {
        this.save(this.defaults);
        return { ...this.defaults };
      }
      const raw = fs.readFileSync(this.configPath, 'utf8');
      const parsed = JSON.parse(raw);
      const parsedProxy = parsed.proxy || {};
      const parsedLibrary = parsed.library || {};
      return {
        ...this.defaults,
        ...parsed,
        library: { ...this.defaults.library, ...parsedLibrary },
        settings: {
          ...this.defaults.settings,
          ...(parsed.settings || {}),
          appearance: {
            ...this.defaults.settings.appearance,
            ...((parsed.settings && parsed.settings.appearance) || {})
          },
          equalizer: {
            ...this.defaults.settings.equalizer,
            ...((parsed.settings && parsed.settings.equalizer) || {})
          },
          overlay: {
            ...this.defaults.settings.overlay,
            ...((parsed.settings && parsed.settings.overlay) || {})
          }
        },
        proxy: {
          soundcloud: { ...this.defaults.proxy.soundcloud, ...(parsedProxy.soundcloud || {}) },
          yandex: { ...this.defaults.proxy.yandex, ...(parsedProxy.yandex || {}) }
        },
        soundcloud: { ...this.defaults.soundcloud, ...(parsed.soundcloud || {}) },
        yandex: { ...this.defaults.yandex, ...(parsed.yandex || {}) }
      };
    } catch (e) {
      console.error('Error loading config:', e);
      return { ...this.defaults };
    }
  }

  save(newConfig) {
    try {
      if (!fs.existsSync(this.userDataPath)) {
        fs.mkdirSync(this.userDataPath, { recursive: true });
      }
      const cur = this.config || this.defaults;
      const curProxy = cur.proxy || this.defaults.proxy;
      const newProxy = (newConfig && newConfig.proxy) || {};
      this.config = {
        ...this.defaults,
        ...cur,
        ...newConfig,
        library: { ...(cur.library || this.defaults.library), ...((newConfig && newConfig.library) || {}) },
        settings: {
          ...(cur.settings || this.defaults.settings),
          ...((newConfig && newConfig.settings) || {}),
          appearance: {
            ...((cur.settings && cur.settings.appearance) || this.defaults.settings.appearance),
            ...((newConfig && newConfig.settings && newConfig.settings.appearance) || {})
          },
          equalizer: {
            ...((cur.settings && cur.settings.equalizer) || this.defaults.settings.equalizer),
            ...((newConfig && newConfig.settings && newConfig.settings.equalizer) || {})
          },
          overlay: {
            ...((cur.settings && cur.settings.overlay) || this.defaults.settings.overlay),
            ...((newConfig && newConfig.settings && newConfig.settings.overlay) || {})
          }
        },
        proxy: {
          soundcloud: { ...(curProxy.soundcloud || this.defaults.proxy.soundcloud), ...(newProxy.soundcloud || {}) },
          yandex: { ...(curProxy.yandex || this.defaults.proxy.yandex), ...(newProxy.yandex || {}) }
        },
        soundcloud: { ...(cur.soundcloud || this.defaults.soundcloud), ...((newConfig && newConfig.soundcloud) || {}) },
        yandex: { ...(cur.yandex || this.defaults.yandex), ...((newConfig && newConfig.yandex) || {}) }
      };
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
      return true;
    } catch (e) {
      console.error('Error saving config:', e);
      return false;
    }
  }

  get(key) {
    return key ? this.config[key] : this.config;
  }

  set(key, value) {
    this.config[key] = value;
    return this.save(this.config);
  }
}

module.exports = ConfigStore;
