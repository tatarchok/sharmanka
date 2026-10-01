/* ==========================================================================
   Main Application Coordinator & Webview Manager
   ========================================================================== */

class AppController {
  constructor() {
    this.activeTab = 'library';
    this.config = null;
    this.webviewsLoaded = {
      soundcloud: false,
      yandex: false
    };

    this.init();
  }

  async init() {
    this.config = await window.api.library.getConfig();
    this.bindWindowControls();
    this.bindSidebarToggle();
    this.bindNavigation();
    this.bindPlayerBarControls();
    this.bindEqualizerModal();
    this.bindSettingsModal();
    this.initAppearance();
    this.initCoverAccent();
    window.secretFeatures?.init();
    this.initOverlaySettings();
    this.setupWebviews();
    this.setupShortcuts();

    // Restore volume slider from config
    const savedVol = typeof this.config.volume === 'number' ? this.config.volume : 0.8;
    const volSlider = document.getElementById('vol-slider');
    if (volSlider) volSlider.value = savedVol;
    window.localPlayer.setVolume(savedVol);

    // Restore equalizer from config
    if (this.config.settings?.equalizer) {
      window.localPlayer.setEqualizer(this.config.settings.equalizer);
    }
    this.populateEqualizerUI();

    // Set initial tab
    const initialTab = this.config.settings?.activeTab || 'library';
    this.switchTab(initialTab);
  }

  bindWindowControls() {
    document.getElementById('btn-win-min')?.addEventListener('click', () => window.api.app.minimize());
    document.getElementById('btn-win-max')?.addEventListener('click', () => window.api.app.maximize());
    document.getElementById('btn-win-close')?.addEventListener('click', () => window.api.app.close());
  }

  bindSidebarToggle() {
    // Sidebar is permanently in compact icon rail mode
  }

  bindNavigation() {
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const tab = item.dataset.tab;
        if (tab) this.switchTab(tab);
      });
    });
  }

  switchTab(tabName) {
    this.activeTab = tabName;

    // Update sidebar active states
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.tab === tabName);
    });

    // Update views visibility
    document.querySelectorAll('.tab-view').forEach(view => {
      const isTarget = view.id === `view-${tabName}`;
      view.classList.toggle('active', isTarget);
      view.style.display = isTarget ? 'flex' : 'none';
    });

    // Lazy load webviews when tab is opened
    if (tabName === 'soundcloud' && !this.webviewsLoaded.soundcloud) {
      this.loadSoundcloudWebview();
    } else if (tabName === 'yandex' && !this.webviewsLoaded.yandex) {
      this.loadYandexWebview();
    }

    // Save active tab
    if (this.config) {
      this.config.settings = { ...(this.config.settings || {}), activeTab: tabName };
      window.api.library.saveConfig(this.config);
    }
  }

  // Spin the floating reload button until the page finished loading
  spinReloadButton(btnId, wv) {
    const btn = document.getElementById(btnId);
    if (!btn || !wv) return;
    btn.classList.add('spinning');
    const stop = () => btn.classList.remove('spinning');
    wv.addEventListener('did-stop-loading', stop, { once: true });
    setTimeout(stop, 15000);
  }

  setupWebviews() {
    // Soundcloud reload button
    document.getElementById('btn-sc-reload')?.addEventListener('click', () => {
      const wv = document.getElementById('wv-soundcloud');
      if (wv) {
        document.getElementById('soundcloud-error-overlay')?.setAttribute('style', 'display: none;');
        this.spinReloadButton('btn-sc-reload', wv);
        wv.reload();
      }
    });

    // SoundCloud error overlay buttons
    document.getElementById('btn-soundcloud-open-proxy')?.addEventListener('click', () => {
      this.openSettingsModal('proxy');
    });

    document.getElementById('btn-soundcloud-retry')?.addEventListener('click', () => {
      const wv = document.getElementById('wv-soundcloud');
      if (wv) {
        document.getElementById('soundcloud-error-overlay')?.setAttribute('style', 'display: none;');
        wv.src = 'https://soundcloud.com';
        wv.reload();
      }
    });

    // Yandex reload button
    document.getElementById('btn-ym-reload')?.addEventListener('click', () => {
      const wv = document.getElementById('wv-yandex');
      if (wv) {
        this.spinReloadButton('btn-ym-reload', wv);
        wv.reload();
      }
    });
  }

  loadSoundcloudWebview() {
    const wv = document.getElementById('wv-soundcloud');
    if (!wv) return;

    // Preload must be set before src: it attaches the bridge before SoundCloud creates its audio elements
    wv.setAttribute('preload', new URL('../injected/soundcloud/sc-preload.js', window.location.href).href);
    wv.src = 'https://soundcloud.com';
    this.webviewsLoaded.soundcloud = true;

    wv.addEventListener('console-message', (e) => {
      if (e.message && e.message.startsWith('MUSICHUB_BRIDGE|')) {
        try {
          const payload = JSON.parse(e.message.replace('MUSICHUB_BRIDGE|', ''));
          window.localPlayer.handleServiceBridgeMessage('soundcloud', payload.event, payload.data);
        } catch (err) {}
      }
    });

    const hideOverlay = () => {
      const overlay = document.getElementById('soundcloud-error-overlay');
      if (overlay) overlay.style.display = 'none';
    };

    wv.addEventListener('did-start-loading', hideOverlay);
    wv.addEventListener('did-finish-load', hideOverlay);
    wv.addEventListener('dom-ready', hideOverlay);

    wv.addEventListener('did-fail-load', (e) => {
      console.warn('SoundCloud load failed:', e.errorCode, e.errorDescription);
      // Ignore normal redirects (-3: ERR_ABORTED), adblock cancellations (-27), and no-error (0)
      if (e.errorCode === -3 || e.errorCode === -27 || e.errorCode === 0) {
        return;
      }
      if (e.isMainFrame) {
        const overlay = document.getElementById('soundcloud-error-overlay');
        const desc = document.getElementById('soundcloud-error-desc');
        if (overlay) {
          overlay.style.display = 'flex';
          if (desc) {
            desc.textContent = `Не удалось подключиться к серверам SoundCloud (${e.errorDescription || 'Ошибка соединения'}). Сервис заблокирован в РФ — настройте зарубежный Прокси (США, Германия, Нидерланды и др.) в Настройках или запустите VPN.`;
          }
        }
      }
    });

    const injectScripts = async () => {
      try {
        const sciCss = await window.api.services.getSoundcloudThemePath('SCI.css');
        const themeCss = await window.api.services.getSoundcloudThemePath('Glassmorphism.css');
        const sciJs = await window.api.services.getSoundcloudPluginPath('SCI.js');
        const bridgeJs = await window.api.services.getSoundcloudBridge();

        if (sciCss) { try { await wv.insertCSS(sciCss); } catch (e) {} }
        if (themeCss) { try { await wv.insertCSS(themeCss); } catch (e) {} }
        if (sciJs) {
          try { await wv.executeJavaScript(sciJs); } catch (err) {}
        }
        if (bridgeJs) {
          try { await wv.executeJavaScript(bridgeJs); } catch (err) {}
        }

        const curVol = window.localPlayer?.audio?.volume || 0.8;
        window.localPlayer.sendWebviewCommand('wv-soundcloud', 'setVolume', curVol);
        if (window.localPlayer?.equalizer) {
          window.localPlayer.sendWebviewCommand('wv-soundcloud', 'setEqualizer', window.localPlayer.equalizer);
        }
        if (window.bgVisualizer?.isActive()) {
          window.localPlayer.sendWebviewCommand('wv-soundcloud', 'setVisualizer', true);
        }
      } catch (e) {}
    };

    wv.addEventListener('dom-ready', injectScripts);
    wv.addEventListener('did-stop-loading', injectScripts);
    wv.addEventListener('did-navigate-in-page', injectScripts);
  }



  loadYandexWebview() {
    const wv = document.getElementById('wv-yandex');
    if (!wv) return;

    wv.src = 'https://music.yandex.ru';
    this.webviewsLoaded.yandex = true;

    wv.addEventListener('console-message', (e) => {
      if (e.message && e.message.startsWith('MUSICHUB_BRIDGE|')) {
        try {
          const payload = JSON.parse(e.message.replace('MUSICHUB_BRIDGE|', ''));
          window.localPlayer.handleServiceBridgeMessage('yandex', payload.event, payload.data);
        } catch (err) {}
      }
    });

    const injectScripts = async () => {
      try {
        const yandexCss = await window.api.services.getYandexStyle();
        const bridgeJs = await window.api.services.getYandexBridge();
        if (yandexCss) wv.insertCSS(yandexCss);
        if (bridgeJs) {
          try { await wv.executeJavaScript(bridgeJs); } catch (err) {}
        }

        const curVol = window.localPlayer?.audio?.volume || 0.8;
        window.localPlayer.sendWebviewCommand('wv-yandex', 'setVolume', curVol);
        if (window.localPlayer?.equalizer) {
          window.localPlayer.sendWebviewCommand('wv-yandex', 'setEqualizer', window.localPlayer.equalizer);
        }
        if (window.bgVisualizer?.isActive()) {
          window.localPlayer.sendWebviewCommand('wv-yandex', 'setVisualizer', true);
        }
      } catch (e) {}
    };

    wv.addEventListener('dom-ready', injectScripts);
    wv.addEventListener('did-stop-loading', injectScripts);
    wv.addEventListener('did-navigate-in-page', injectScripts);
  }

  bindPlayerBarControls() {
    // Play/Pause
    document.getElementById('ctrl-play')?.addEventListener('click', () => {
      window.localPlayer.togglePlay();
    });

    // Prev / Next
    document.getElementById('ctrl-prev')?.addEventListener('click', () => {
      window.localPlayer.previous();
    });

    document.getElementById('ctrl-next')?.addEventListener('click', () => {
      window.localPlayer.next();
    });

    // Shuffle / Repeat
    document.getElementById('ctrl-shuffle')?.addEventListener('click', () => {
      window.localPlayer.toggleShuffle();
    });

    document.getElementById('ctrl-repeat')?.addEventListener('click', () => {
      window.localPlayer.toggleRepeat();
    });

    // Seek bar click & drag handling (audio keeps playing uninterrupted while dragging)
    const seekBar = document.getElementById('seek-bar');
    if (seekBar) {
      let isPointerDown = false;

      const calculatePercent = (clientX) => {
        const rect = seekBar.getBoundingClientRect();
        if (rect.width <= 0) return 0;
        const offsetX = clientX - rect.left;
        return Math.max(0, Math.min(100, (offsetX / rect.width) * 100));
      };

      seekBar.addEventListener('pointerdown', (e) => {
        isPointerDown = true;
        window.localPlayer.isDraggingSeek = true;
        seekBar.classList.add('dragging');
        try { seekBar.setPointerCapture(e.pointerId); } catch (err) {}

        const percent = calculatePercent(e.clientX);
        window.localPlayer.updateDragProgressUI(percent);
      });

      seekBar.addEventListener('pointermove', (e) => {
        if (!isPointerDown) return;
        const percent = calculatePercent(e.clientX);
        window.localPlayer.updateDragProgressUI(percent);
      });

      const handlePointerUp = (e) => {
        if (!isPointerDown) return;
        isPointerDown = false;
        window.localPlayer.isDraggingSeek = false;
        seekBar.classList.remove('dragging');
        try { seekBar.releasePointerCapture(e.pointerId); } catch (err) {}

        const percent = calculatePercent(e.clientX);
        window.localPlayer.seek(percent);
      };

      seekBar.addEventListener('pointerup', handlePointerUp);
      seekBar.addEventListener('pointercancel', handlePointerUp);
    }

    // Volume Icon click (Mute / Unmute toggle)
    document.getElementById('btn-volume-icon')?.addEventListener('click', () => {
      window.localPlayer.toggleMute();
    });

    // Volume Slider & Mouse Wheel Control
    const volSlider = document.getElementById('vol-slider');
    const volContainer = document.querySelector('.volume-container');

    if (volSlider) {
      const updateVolFill = (val) => {
        const pct = (val * 100).toFixed(1);
        volSlider.style.setProperty('--vol-percent', `${pct}%`);
      };

      volSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        updateVolFill(val);
        window.localPlayer.setVolume(val);
        if (this.config) {
          this.config.volume = val;
          window.api.library.saveConfig(this.config).catch(() => {});
        }
      });

      const initialVol = typeof this.config?.volume === 'number' ? this.config.volume : 0.8;
      updateVolFill(initialVol);
    }

    if (volContainer) {
      volContainer.addEventListener('wheel', (e) => {
        e.preventDefault();
        const currentVol = typeof window.localPlayer?.audio?.volume === 'number'
          ? window.localPlayer.audio.volume
          : (volSlider ? parseFloat(volSlider.value) : 0.8);
        const step = 0.05;
        const delta = (e.deltaY < 0 || e.deltaX > 0) ? step : -step;
        const nextVol = Math.max(0, Math.min(1, Math.round((currentVol + delta) * 100) / 100));

        window.localPlayer.setVolume(nextVol);
        if (this.config) {
          this.config.volume = nextVol;
          window.api.library.saveConfig(this.config).catch(() => {});
        }
      }, { passive: false });
    }
  }

  bindEqualizerModal() {
    const openBtn = document.getElementById('btn-open-equalizer');
    const closeBtn = document.getElementById('btn-close-equalizer-modal');
    const panel = document.getElementById('equalizer-panel');
    const toggleEnable = document.getElementById('eq-toggle-enable');
    const switchLabel = document.getElementById('eq-switch-label');
    const resetBtn = document.getElementById('btn-eq-reset');
    const board = document.getElementById('eq-sliders-board');

    const EQ_PRESETS = {
      flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      bass_boost: [7, 6, 4, 2, 0, 0, 0, 0, 0, 0],
      bass_treble: [6, 4, 1, -1, -2, 0, 2, 4, 6, 7],
      electronic: [5, 4, 2, 0, -1, 2, 1, 3, 5, 5],
      rock: [5, 3, 2, -1, -2, 1, 3, 4, 4, 3],
      hiphop: [6, 5, 3, 1, -1, -1, 1, 2, 3, 4],
      pop: [-1, 1, 3, 4, 4, 2, 0, 1, 2, 2],
      vocal: [-2, -1, 0, 2, 4, 4, 3, 2, 1, 0],
      jazz: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3],
      classical: [4, 3, 2, 2, -1, -1, 0, 2, 3, 3]
    };
    const EQ_LABELS = ['32', '64', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];

    // Popover in the same spot as the queue drawer; only one of them is open at a time
    if (openBtn && panel) {
      openBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (panel.classList.contains('active')) {
          this.closeEqualizerPanel();
          return;
        }
        document.getElementById('queue-drawer')?.classList.remove('active');
        document.getElementById('btn-toggle-queue')?.classList.remove('active');
        this.populateEqualizerUI();
        panel.classList.add('active');
        openBtn.classList.add('active');
      });
    }

    closeBtn?.addEventListener('click', () => this.closeEqualizerPanel());

    // Close on outside click
    window.addEventListener('click', (e) => {
      if (!panel || !panel.classList.contains('active')) return;
      const path = e.composedPath ? e.composedPath() : [];
      if (!path.includes(panel) && !openBtn?.contains(e.target)) this.closeEqualizerPanel();
    });

    const currentEq = window.localPlayer?.equalizer || { gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
    const currentGains = currentEq.gains || [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

    // Render 10-band sliders
    if (board) {
      board.innerHTML = '';
      EQ_LABELS.forEach((label, idx) => {
        const val = currentGains[idx] || 0;
        const col = document.createElement('div');
        col.className = 'eq-band-col';
        col.innerHTML = `
          <span class="eq-val-label ${val !== 0 ? 'highlight' : ''}" id="eq-val-${idx}">${val > 0 ? '+' : ''}${val}dB</span>
          <div class="eq-slider-vertical-wrap">
            <input type="range" class="eq-slider-vertical" id="eq-slider-${idx}" min="-12" max="12" step="1" value="${val}" data-band="${idx}" />
          </div>
          <span class="eq-freq-label">${label}</span>
        `;
        board.appendChild(col);
      });

      board.querySelectorAll('.eq-slider-vertical').forEach(slider => {
        slider.addEventListener('input', (e) => {
          const band = parseInt(e.target.dataset.band, 10);
          const val = parseInt(e.target.value, 10);
          const labelEl = document.getElementById(`eq-val-${band}`);
          if (labelEl) {
            labelEl.textContent = `${val > 0 ? '+' : ''}${val}dB`;
            labelEl.classList.toggle('highlight', val !== 0);
          }

          const curGains = [...(window.localPlayer?.equalizer?.gains || [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])];
          curGains[band] = val;

          this.setActiveEqPresetChip('custom');

          window.localPlayer.setEqualizer({
            preset: 'custom',
            gains: curGains
          });

          if (!this.config.settings) this.config.settings = {};
          this.config.settings.equalizer = window.localPlayer.equalizer;
          window.api.library.saveConfig(this.config).catch(() => {});
        });
      });
    }

    // Presets chips
    document.querySelectorAll('.eq-preset-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const presetKey = chip.dataset.preset;
        if (!presetKey || presetKey === 'custom') return;
        const gains = EQ_PRESETS[presetKey];
        if (gains) {
          this.setActiveEqPresetChip(presetKey);
          this.updateEqSlidersUI(gains);
          window.localPlayer.setEqualizer({
            preset: presetKey,
            gains
          });
          if (!this.config.settings) this.config.settings = {};
          this.config.settings.equalizer = window.localPlayer.equalizer;
          window.api.library.saveConfig(this.config).catch(() => {});
        }
      });
    });

    // Reset button
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        const flatGains = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        this.setActiveEqPresetChip('flat');
        this.updateEqSlidersUI(flatGains);
        window.localPlayer.setEqualizer({
          preset: 'flat',
          gains: flatGains
        });
        if (!this.config.settings) this.config.settings = {};
        this.config.settings.equalizer = window.localPlayer.equalizer;
        window.api.library.saveConfig(this.config).catch(() => {});
      });
    }

    // Toggle switch
    if (toggleEnable) {
      toggleEnable.addEventListener('change', () => {
        const isEnabled = toggleEnable.checked;
        if (switchLabel) switchLabel.textContent = isEnabled ? 'Вкл' : 'Выкл';
        panel?.classList.toggle('eq-disabled', !isEnabled);
        window.localPlayer.setEqualizer({ enabled: isEnabled });
        if (!this.config.settings) this.config.settings = {};
        this.config.settings.equalizer = window.localPlayer.equalizer;
        window.api.library.saveConfig(this.config).catch(() => {});
      });
    }
  }

  closeEqualizerPanel() {
    document.getElementById('equalizer-panel')?.classList.remove('active');
    document.getElementById('btn-open-equalizer')?.classList.remove('active');
  }

  setActiveEqPresetChip(presetKey) {
    document.querySelectorAll('.eq-preset-chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.preset === presetKey);
    });
  }

  updateEqSlidersUI(gains) {
    if (!Array.isArray(gains)) return;
    gains.forEach((val, idx) => {
      const slider = document.getElementById(`eq-slider-${idx}`);
      const label = document.getElementById(`eq-val-${idx}`);
      if (slider) slider.value = val;
      if (label) {
        label.textContent = `${val > 0 ? '+' : ''}${val}dB`;
        label.classList.toggle('highlight', val !== 0);
      }
    });
  }

  populateEqualizerUI() {
    const eq = window.localPlayer?.equalizer || { enabled: true, preset: 'flat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
    const toggleEnable = document.getElementById('eq-toggle-enable');
    const switchLabel = document.getElementById('eq-switch-label');

    if (toggleEnable) toggleEnable.checked = eq.enabled !== false;
    if (switchLabel) switchLabel.textContent = (eq.enabled !== false) ? 'Вкл' : 'Выкл';
    document.getElementById('equalizer-panel')?.classList.toggle('eq-disabled', eq.enabled === false);

    this.setActiveEqPresetChip(eq.preset || 'flat');
    this.updateEqSlidersUI(eq.gains || [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  }

  bindSettingsModal() {
    const openBtn = document.getElementById('btn-open-settings');
    const closeBtn = document.getElementById('btn-close-settings');
    const modal = document.getElementById('settings-modal');
    this.bindSettingsNavigation();

    if (openBtn && modal) {
      openBtn.addEventListener('click', () => {
        this.openSettingsModal('folders');
      });
    }

    if (closeBtn && modal) {
      closeBtn.addEventListener('click', () => {
        modal.classList.remove('active');
      });
    }

    // Choose music folder button in settings
    document.getElementById('btn-settings-choose-folder')?.addEventListener('click', async () => {
      const curPath = this.config.library?.musicFolder || '';
      const selected = await window.api.library.selectDirectory(curPath);
      if (selected) {
        if (!this.config.library) this.config.library = {};
        this.config.library.musicFolder = selected;
        this.config.library.folders = [selected];
        await window.api.library.saveConfig(this.config);
        this.populateSettingsUI();
        window.libraryUI?.scanLibrary();
      }
    });

    // Rescan music folder
    document.getElementById('btn-settings-rescan-folder')?.addEventListener('click', () => {
      window.libraryUI?.scanLibrary();
    });

    // Network storage (WebDAV)
    const remoteForm = () => ({
      url: document.getElementById('remote-url')?.value.trim() || '',
      username: document.getElementById('remote-username')?.value.trim() || '',
      password: document.getElementById('remote-password')?.value || ''
    });
    const setRemoteStatus = (text, kind = 'muted') => {
      const el = document.getElementById('remote-status-text');
      if (!el) return;
      el.textContent = text;
      el.style.color = kind === 'error' ? '#f87171' : kind === 'ok' ? '#4ade80' : 'var(--text-muted)';
    };
    const describeTest = (r) => `Подключение успешно: в папке ${r.folders} папок и ${r.files} файлов.`;
    const cleanError = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

    document.getElementById('btn-remote-test')?.addEventListener('click', async () => {
      setRemoteStatus('Проверка подключения…');
      try {
        const r = await window.api.remote.test(remoteForm());
        setRemoteStatus(describeTest(r), 'ok');
      } catch (e) {
        setRemoteStatus(cleanError(e), 'error');
      }
    });

    document.getElementById('btn-remote-connect')?.addEventListener('click', async () => {
      setRemoteStatus('Подключение…');
      try {
        const r = await window.api.remote.connect(remoteForm());
        this.config = r.config;
        document.getElementById('remote-password').value = '';
        setRemoteStatus(`${describeTest(r)} Сканирую медиатеку…`, 'ok');
        this.populateSettingsUI();
        await window.libraryUI?.scanLibrary();
        this.populateSettingsUI();
      } catch (e) {
        setRemoteStatus(cleanError(e), 'error');
      }
    });

    document.getElementById('btn-remote-disconnect')?.addEventListener('click', async () => {
      this.config = await window.api.remote.disconnect();
      setRemoteStatus('Сетевое хранилище отключено. Выберите папку на ПК или подключите сервер снова.');
      this.populateSettingsUI();
      window.libraryUI?.scanLibrary();
    });

    // Online covers
    document.getElementById('settings-auto-covers')?.addEventListener('change', async (e) => {
      if (!this.config.library) this.config.library = {};
      this.config.library.autoCovers = e.target.checked;
      await window.api.library.saveConfig(this.config);
    });

    document.getElementById('btn-find-covers')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-find-covers');
      const status = document.getElementById('covers-status-text');
      btn.disabled = true;
      if (status) status.textContent = 'Поиск…';
      const off = window.api.library.onCoversProgress((p) => {
        if (status && p && !p.finished && p.total) status.textContent = `${p.done}/${p.total}, найдено ${p.found}`;
      });
      try {
        const r = await window.api.library.findCovers();
        if (status) {
          status.textContent = r && r.skipped
            ? 'Поиск уже идёт в фоне'
            : (r && r.total ? `Готово: найдено ${r.found} из ${r.total}` : 'У всех треков и альбомов уже есть обложки');
        }
      } catch (err) {
        if (status) status.textContent = 'Ошибка поиска обложек';
      } finally {
        off();
        btn.disabled = false;
      }
    });

    // Clear music folder
    document.getElementById('btn-settings-clear-folder')?.addEventListener('click', async () => {
      if (!this.config.library) this.config.library = {};
      this.config.library.musicFolder = '';
      this.config.library.folders = [];
      await window.api.library.saveConfig(this.config);
      this.populateSettingsUI();
      window.libraryUI?.scanLibrary();
    });

    // Proxy section: every change is applied and checked right away (no "Save" button)
    this.bindProxySettings();
  }

  // ---- Proxy (Settings → Прокси) ------------------------------------------------
  proxyEls(service) {
    const $ = (id) => document.getElementById(id);
    return {
      card: document.querySelector(`.proxy-card-min[data-service="${service}"]`),
      enable: $(`proxy-${service}-enable`),
      address: $(`proxy-${service}-address`),
      user: $(`proxy-${service}-user`),
      pass: $(`proxy-${service}-pass`),
      auth: $(`proxy-${service}-auth`),
      test: $(`proxy-${service}-test`),
      status: $(`proxy-status-${service}`),
      warn: $(`proxy-warn-${service}`)
    };
  }

  // One address field ("socks5://user:pass@host:port", "host:port", "host:port:user:pass")
  // plus optional login/password fields
  proxyFormValues(service) {
    const els = this.proxyEls(service);
    const saved = this.config?.proxy?.[service] || {};
    const parsed = els.address?.value.trim() ? this.parsePastedProxy(els.address.value.trim()) : null;
    return {
      enabled: !!els.enable?.checked,
      type: parsed?.type || saved.type || 'socks5',
      host: parsed?.host || '',
      port: parsed?.port || '',
      username: els.user?.value.trim() || parsed?.username || '',
      password: els.pass?.value || parsed?.password || ''
    };
  }

  setProxyStatus(service, text, kind = '') {
    const { status } = this.proxyEls(service);
    if (!status) return;
    status.textContent = text;
    status.className = 'proxy-status' + (kind ? ` ${kind}` : '');
  }

  // Keep the address field clean: credentials go to their own fields, "type://host:port" stays
  normalizeProxyAddress(service) {
    const els = this.proxyEls(service);
    const raw = els.address?.value.trim();
    if (!raw) return;
    const parsed = this.parsePastedProxy(raw);
    if (!parsed || !parsed.host) return;
    if (parsed.username && els.user) els.user.value = parsed.username;
    if (parsed.password && els.pass) els.pass.value = parsed.password;
    if (parsed.username && els.auth) els.auth.open = true;
    const type = parsed.type || this.config?.proxy?.[service]?.type || 'socks5';
    els.address.value = `${type}://${parsed.host}${parsed.port ? ':' + parsed.port : ''}`;
  }

  bindProxySettings() {
    ['soundcloud', 'yandex'].forEach(service => {
      const els = this.proxyEls(service);
      els.enable?.addEventListener('change', () => this.applyProxy(service));
      els.address?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') els.address.blur();
      });
      els.address?.addEventListener('change', () => {
        this.normalizeProxyAddress(service);
        // Typing an address implies "use it"
        if (els.address.value.trim() && els.enable && !els.enable.checked) els.enable.checked = true;
        this.applyProxy(service);
      });
      els.user?.addEventListener('change', () => this.applyProxy(service));
      els.pass?.addEventListener('change', () => this.applyProxy(service));
      els.test?.addEventListener('click', () => this.runProxyTest(service));
    });
  }

  async applyProxy(service) {
    const els = this.proxyEls(service);
    const values = this.proxyFormValues(service);
    els.card?.classList.toggle('is-enabled', values.enabled);
    if (els.warn) els.warn.style.display = 'none';

    if (values.enabled && !values.host) {
      this.setProxyStatus(service, 'Укажите адрес прокси', 'error');
      return;
    }

    this.setProxyStatus(service, 'Применение…', 'checking');
    await window.api.proxy.setServiceProxy(service, values);
    this.config = await window.api.library.getConfig();
    this.reloadWebview(service);

    if (values.enabled) {
      await this.runProxyTest(service);
    } else {
      this.setProxyStatus(service, 'Напрямую');
    }
  }

  async runProxyTest(service) {
    const els = this.proxyEls(service);
    const values = this.proxyFormValues(service);
    if (!values.host) {
      this.setProxyStatus(service, 'Укажите адрес прокси', 'error');
      return;
    }
    this.setProxyStatus(service, 'Проверка…', 'checking');
    if (els.test) els.test.disabled = true;
    if (els.warn) els.warn.style.display = 'none';

    try {
      const res = await window.api.proxy.testProxy(values);
      if (res && res.success) {
        // Remember the protocol that actually works
        if (res.detectedType && res.detectedType !== values.type) {
          const fixed = { ...values, type: res.detectedType };
          if (els.address) els.address.value = `${res.detectedType}://${values.host}:${values.port}`;
          await window.api.proxy.setServiceProxy(service, fixed);
          this.config = await window.api.library.getConfig();
        }
        // Country name only: Windows fonts render flag emoji as two letters ("FI")
        const where = res.country || '';
        const suffix = values.enabled ? '' : ' · выключен';
        this.setProxyStatus(service, `${where ? where + ' · ' : ''}${res.pingMs || res.latencyMs} мс · ${res.ip}${suffix}`, 'ok');
        if (res.warning && service === 'soundcloud' && els.warn) {
          els.warn.textContent = res.warning;
          els.warn.style.display = 'block';
        }
      } else {
        this.setProxyStatus(service, res?.error || 'Прокси не отвечает', 'error');
      }
    } catch (e) {
      this.setProxyStatus(service, e.message || 'Прокси не отвечает', 'error');
    } finally {
      if (els.test) els.test.disabled = false;
    }
  }

  initAppearance() {
    const appearance = this.config?.settings?.appearance || {
      accentColor: '#6366f1',
      bgImage: '',
      bgDim: 40,
      bgBlur: 10
    };

    // Apply saved appearance on startup
    this.applyAppearance(appearance);

    // Accent color presets
    document.querySelectorAll('.color-preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const color = btn.dataset.color;
        if (color) this.setAccentColor(color);
      });
    });

    // Custom color picker
    const picker = document.getElementById('accent-color-picker');
    if (picker) {
      picker.addEventListener('input', (e) => {
        this.setAccentColor(e.target.value);
      });
    }

    // Choose background image
    document.getElementById('btn-choose-bg-image')?.addEventListener('click', async () => {
      const selected = await window.api.library.selectImage();
      if (selected) {
        this.setCustomBackground(selected);
      }
    });

    // Remove background image
    document.getElementById('btn-remove-bg-image')?.addEventListener('click', () => {
      this.setCustomBackground('');
    });

    // Dimming slider
    const dimSlider = document.getElementById('slider-bg-dim');
    if (dimSlider) {
      dimSlider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        this.setBgDim(val);
      });
    }

    // Blur slider
    const blurSlider = document.getElementById('slider-bg-blur');
    if (blurSlider) {
      blurSlider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        this.setBgBlur(val);
      });
    }

    // Beat-reactive background presets
    document.querySelectorAll('.bg-anim-card').forEach(card => {
      card.addEventListener('click', () => this.setBgAnimation(card.dataset.anim));
    });
    document.getElementById('slider-bg-anim-sens')?.addEventListener('input', (e) => {
      this.setBgAnimSensitivity(parseInt(e.target.value, 10));
    });
  }

  setBgAnimation(preset) {
    if (!this.config.settings) this.config.settings = {};
    if (!this.config.settings.appearance) this.config.settings.appearance = {};
    this.config.settings.appearance.bgAnimation = preset || 'none';
    window.api.library.saveConfig(this.config);
    window.bgVisualizer?.setPreset(preset);
    this.updateBgAnimationUI(this.config.settings.appearance);
  }

  setBgAnimSensitivity(value) {
    if (!this.config.settings) this.config.settings = {};
    if (!this.config.settings.appearance) this.config.settings.appearance = {};
    this.config.settings.appearance.bgAnimSensitivity = value;
    window.api.library.saveConfig(this.config);
    window.bgVisualizer?.setSensitivity(value / 100);
    this.updateBgAnimationUI(this.config.settings.appearance);
  }

  updateBgAnimationUI(appearance) {
    const preset = appearance?.bgAnimation || 'particles';
    const sens = typeof appearance?.bgAnimSensitivity === 'number' ? appearance.bgAnimSensitivity : 100;
    document.querySelectorAll('.bg-anim-card').forEach(card => {
      card.classList.toggle('active', card.dataset.anim === preset);
    });
    const slider = document.getElementById('slider-bg-anim-sens');
    const label = document.getElementById('bg-anim-sens-label');
    if (slider) slider.value = sens;
    if (label) label.textContent = `${sens}%`;
  }

  initOverlaySettings() {
    const overlay = this.config?.settings?.overlay || { enabled: false, position: 'bottom-right' };
    this.updateOverlaySettingsUI(overlay);

    document.getElementById('overlay-enable-toggle')?.addEventListener('change', (e) => {
      this.setOverlaySetting('enabled', e.target.checked);
    });

    document.querySelectorAll('.overlay-position-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const position = btn.dataset.position;
        if (position) this.setOverlaySetting('position', position, true);
      });
    });

    document.getElementById('overlay-display-presets')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.overlay-display-btn');
      if (btn) this.setOverlaySetting('display', btn.dataset.display, true);
    });
    window.api.overlay.onDisplaysChanged?.(() => this.renderOverlayDisplays());
    this.renderOverlayDisplays();
  }

  async setOverlaySetting(key, value, preview = false) {
    if (!this.config.settings) this.config.settings = {};
    if (!this.config.settings.overlay) this.config.settings.overlay = { enabled: false, position: 'bottom-right' };
    this.config.settings.overlay[key] = value;
    this.updateOverlaySettingsUI(this.config.settings.overlay);
    await window.api.library.saveConfig(this.config);
    // show the mini player for a moment where it will appear
    if (preview) window.api.overlay.preview?.();
  }

  async renderOverlayDisplays() {
    const row = document.getElementById('overlay-display-row');
    const list = document.getElementById('overlay-display-presets');
    if (!row || !list || !window.api.overlay.getDisplays) return;
    let displays = [];
    try { displays = await window.api.overlay.getDisplays(); } catch (e) {}
    // nothing to choose with a single monitor
    row.hidden = displays.length < 2;
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    list.innerHTML = [
      `<button type="button" class="set-segment overlay-display-btn" data-display="app" title="Мини-плеер появится на том экране, где было окно Sharmanka">
        <span class="overlay-display-name">Где окно приложения</span>
      </button>`,
      ...displays.map(d => `
        <button type="button" class="set-segment overlay-display-btn" data-display="${esc(d.id)}" data-selected="${d.selected ? 1 : 0}" title="${esc(d.label || `Монитор ${d.index}`)}">
          <span class="overlay-display-name">Монитор ${d.index}${d.primary ? ' · основной' : ''}</span>
          <span class="overlay-display-meta">${d.width}×${d.height}</span>
        </button>`)
    ].join('');
    this.updateOverlaySettingsUI(this.config?.settings?.overlay || {});
  }

  updateOverlaySettingsUI(overlay) {
    const toggle = document.getElementById('overlay-enable-toggle');
    if (toggle) toggle.checked = !!overlay.enabled;

    document.querySelectorAll('.overlay-position-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.position === (overlay.position || 'bottom-right'));
    });

    const btns = Array.from(document.querySelectorAll('.overlay-display-btn'));
    const wanted = overlay.display == null ? 'primary' : String(overlay.display);
    // 'primary' or an unplugged monitor → highlight the current primary one
    const active = btns.find(b => b.dataset.display === wanted)
      || btns.find(b => b.dataset.selected === '1')
      || btns.find(b => b.querySelector('.overlay-display-name')?.textContent.includes('основной'));
    btns.forEach(b => b.classList.toggle('active', b === active));
  }

  applyAppearance(appearance) {
    if (!appearance) return;
    const accentColor = appearance.accentColor || '#6366f1';
    const bgImage = appearance.bgImage || '';
    const bgDim = typeof appearance.bgDim === 'number' ? appearance.bgDim : 40;
    const bgBlur = typeof appearance.bgBlur === 'number' ? appearance.bgBlur : 10;

    // Apply CSS variables (the artwork color replaces the accent when that option is on)
    this.applyAccentVars(accentColor);
    this.updateCoverAccent();
    document.documentElement.style.setProperty('--custom-bg-dim', (bgDim / 100).toString());
    document.documentElement.style.setProperty('--custom-bg-blur', `${bgBlur}px`);

    // Apply background image
    this.applyBackgroundImage(bgImage);

    // Beat-reactive animated background
    const sens = typeof appearance.bgAnimSensitivity === 'number' ? appearance.bgAnimSensitivity : 100;
    window.bgVisualizer?.setSensitivity(sens / 100);
    window.bgVisualizer?.setPreset(appearance.bgAnimation || 'particles');
    this.updateBgAnimationUI(appearance);

    // Sync UI elements
    this.updateAppearanceUI(accentColor, bgImage, bgDim, bgBlur);
  }

  setAccentColor(color) {
    if (!color) return;
    if (!this.config.settings) this.config.settings = {};
    if (!this.config.settings.appearance) this.config.settings.appearance = {};
    this.config.settings.appearance.accentColor = color;
    window.api.library.saveConfig(this.config);

    // With "color from artwork" on, the chosen color is the fallback for covers without color
    if (this.config.settings.appearance.accentFromCover) {
      this.updateCoverAccent();
    } else {
      this.applyAccentVars(color);
    }

    this.updateColorPresetsUI(color);
  }

  applyAccentVars(color) {
    const root = document.documentElement.style;
    root.setProperty('--accent-primary', color);
    root.setProperty('--border-focus', color);
    root.setProperty('--accent-gradient', `linear-gradient(135deg, ${color} 0%, color-mix(in srgb, ${color} 75%, #000) 100%)`);
  }

  // ---- Accent color from the playing track's artwork -------------------------
  initCoverAccent() {
    const art = document.getElementById('player-art-img');
    if (art) {
      new MutationObserver(() => {
        clearTimeout(this.coverAccentTimer);
        this.coverAccentTimer = setTimeout(() => this.updateCoverAccent(), 150);
      }).observe(art, { attributes: true, attributeFilter: ['src', 'style'] });
    }
    document.getElementById('settings-accent-from-cover')?.addEventListener('change', (e) => {
      if (!this.config.settings) this.config.settings = {};
      if (!this.config.settings.appearance) this.config.settings.appearance = {};
      this.config.settings.appearance.accentFromCover = e.target.checked;
      window.api.library.saveConfig(this.config);
      this.updateCoverAccent();
    });
  }

  async updateCoverAccent() {
    const appearance = this.config?.settings?.appearance || {};
    const saved = appearance.accentColor || '#6366f1';
    const toggle = document.getElementById('settings-accent-from-cover');
    if (toggle) toggle.checked = !!appearance.accentFromCover;

    if (!appearance.accentFromCover) {
      this.applyAccentVars(saved);
      return;
    }
    const art = document.getElementById('player-art-img');
    const src = art && art.style.display !== 'none' ? art.getAttribute('src') : '';
    if (!src) {
      this.applyAccentVars(saved);
      return;
    }
    const requested = this.coverAccentSrc = src;
    let color = null;
    try {
      color = await window.api.color.fromCover(art.src);
    } catch (e) {
      color = null;
    }
    if (requested !== this.coverAccentSrc) return; // the track changed meanwhile
    this.applyAccentVars(color || saved);
  }

  setCustomBackground(filePath) {
    if (!this.config.settings) this.config.settings = {};
    if (!this.config.settings.appearance) this.config.settings.appearance = {};
    this.config.settings.appearance.bgImage = filePath || '';
    window.api.library.saveConfig(this.config);

    this.applyBackgroundImage(filePath);
    this.updateBackgroundUI(filePath);
  }

  setBgDim(val) {
    if (!this.config.settings) this.config.settings = {};
    if (!this.config.settings.appearance) this.config.settings.appearance = {};
    this.config.settings.appearance.bgDim = val;
    window.api.library.saveConfig(this.config);

    document.documentElement.style.setProperty('--custom-bg-dim', (val / 100).toString());
    const label = document.getElementById('bg-dim-val-label');
    if (label) label.textContent = `${val}%`;
  }

  setBgBlur(val) {
    if (!this.config.settings) this.config.settings = {};
    if (!this.config.settings.appearance) this.config.settings.appearance = {};
    this.config.settings.appearance.bgBlur = val;
    window.api.library.saveConfig(this.config);

    document.documentElement.style.setProperty('--custom-bg-blur', `${val}px`);
    const label = document.getElementById('bg-blur-val-label');
    if (label) label.textContent = `${val} px`;
  }

  applyBackgroundImage(filePath) {
    const bgImageEl = document.getElementById('app-bg-image');
    if (!bgImageEl) return;

    if (filePath && filePath.trim() !== '') {
      const normalizedUrl = `url("file:///${encodeURI(filePath.replace(/\\/g, '/')).replace(/#/g, '%23')}")`;
      bgImageEl.style.backgroundImage = normalizedUrl;
      bgImageEl.classList.add('has-image');
      document.body.classList.add('has-custom-bg');
    } else {
      bgImageEl.style.backgroundImage = 'url("../../background.jpg")';
      bgImageEl.classList.add('has-image');
      document.body.classList.add('has-custom-bg');
    }
  }

  updateAppearanceUI(accentColor, bgImage, bgDim, bgBlur) {
    this.updateColorPresetsUI(accentColor);
    this.updateBackgroundUI(bgImage);

    const dimSlider = document.getElementById('slider-bg-dim');
    const dimLabel = document.getElementById('bg-dim-val-label');
    if (dimSlider) dimSlider.value = bgDim;
    if (dimLabel) dimLabel.textContent = `${bgDim}%`;

    const blurSlider = document.getElementById('slider-bg-blur');
    const blurLabel = document.getElementById('bg-blur-val-label');
    if (blurSlider) blurSlider.value = bgBlur;
    if (blurLabel) blurLabel.textContent = `${bgBlur} px`;
  }

  updateColorPresetsUI(color) {
    const norm = (color || '').toLowerCase();
    document.querySelectorAll('.color-preset-btn').forEach(btn => {
      const btnColor = (btn.dataset.color || '').toLowerCase();
      btn.classList.toggle('active', btnColor === norm);
    });

    const picker = document.getElementById('accent-color-picker');
    if (picker && /^#[0-9a-f]{6}$/i.test(color)) {
      picker.value = color;
    }
  }

  updateBackgroundUI(filePath) {
    const previewEl = document.getElementById('bg-image-preview');
    const placeholderText = document.getElementById('bg-image-placeholder-text');
    if (!previewEl) return;

    if (filePath && filePath.trim() !== '') {
      const normalizedUrl = `url("file:///${encodeURI(filePath.replace(/\\/g, '/')).replace(/#/g, '%23')}")`;
      previewEl.style.backgroundImage = normalizedUrl;
      if (placeholderText) placeholderText.style.display = 'none';
    } else {
      previewEl.style.backgroundImage = 'url("../../background.jpg")';
      if (placeholderText) placeholderText.style.display = 'none';
    }
  }

  openSettingsModal(tab = 'folders') {
    const modal = document.getElementById('settings-modal');
    if (!modal) return;

    this.populateSettingsUI();
    this.populateProxyUI();
    const app = this.config?.settings?.appearance || { accentColor: '#6366f1', bgImage: '', bgDim: 40, bgBlur: 10 };
    this.updateAppearanceUI(app.accentColor, app.bgImage, app.bgDim, app.bgBlur);
    this.updateOverlaySettingsUI(this.config?.settings?.overlay || { enabled: false, position: 'bottom-right' });
    this.renderOverlayDisplays();
    this.switchSettingsTab(tab);
    modal.classList.add('active');
  }

  switchSettingsTab(tabName) {
    const sections = Array.from(document.querySelectorAll('.settings-section'));
    const target = sections.some(s => s.dataset.section === tabName) ? tabName : 'folders';
    document.querySelectorAll('.settings-nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.tab === target);
    });
    sections.forEach(section => {
      section.classList.toggle('active', section.dataset.section === target);
    });
    const content = document.querySelector('.settings-content');
    if (content) content.scrollTop = 0;
    this.refreshSettingsRanges();
  }

  // Accent fill of the settings sliders up to their current value
  refreshSettingsRanges() {
    document.querySelectorAll('.set-range').forEach(range => {
      const min = Number(range.min) || 0;
      const max = Number(range.max) || 100;
      const pct = ((Number(range.value) - min) / (max - min)) * 100;
      range.style.setProperty('--fill', `${Math.max(0, Math.min(100, pct))}%`);
    });
  }

  bindSettingsNavigation() {
    const modal = document.getElementById('settings-modal');
    document.querySelectorAll('.set-range').forEach(range => {
      range.addEventListener('input', () => this.refreshSettingsRanges());
    });
    document.querySelectorAll('.settings-nav-item').forEach(item => {
      item.addEventListener('click', () => this.switchSettingsTab(item.dataset.tab));
    });
    // Close by clicking the dimmed backdrop or with Esc
    modal?.addEventListener('mousedown', (e) => {
      if (e.target === modal) modal.classList.remove('active');
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal?.classList.contains('active')) modal.classList.remove('active');
    });
  }

  populateSettingsUI() {
    const pathInput = document.getElementById('settings-music-folder-path');
    const statsEl = document.getElementById('settings-music-folder-stats');
    const musicFolder = this.config.library?.musicFolder || (Array.isArray(this.config.library?.folders) ? this.config.library.folders[0] : '') || '';

    if (pathInput) {
      pathInput.value = musicFolder;
    }

    const autoCoversEl = document.getElementById('settings-auto-covers');
    if (autoCoversEl) autoCoversEl.checked = this.config.library?.autoCovers !== false;

    // Network storage block
    const remote = this.config.library?.remote || {};
    const isRemoteFolder = /^https?:\/\//i.test(musicFolder);
    const remoteUrlEl = document.getElementById('remote-url');
    const remoteUserEl = document.getElementById('remote-username');
    const remotePassEl = document.getElementById('remote-password');
    if (remoteUrlEl && document.activeElement !== remoteUrlEl) remoteUrlEl.value = remote.url || '';
    if (remoteUserEl && document.activeElement !== remoteUserEl) remoteUserEl.value = remote.username || '';
    if (remotePassEl) remotePassEl.placeholder = remote.password ? 'Пароль сохранён (оставьте пустым)' : 'Пароль';
    const remoteBadge = document.getElementById('remote-status-badge');
    if (remoteBadge) remoteBadge.style.display = isRemoteFolder && remote.url ? 'inline-block' : 'none';
    const disconnectBtn = document.getElementById('btn-remote-disconnect');
    if (disconnectBtn) disconnectBtn.style.display = remote.url ? 'inline-flex' : 'none';

    if (statsEl) {
      const tracksCount = window.libraryUI?.tracks?.length || 0;
      const albumsCount = window.libraryUI?.albums?.length || 0;
      if (musicFolder) {
        statsEl.textContent = `✓ Найдено в медиатеке: ${tracksCount} треков, ${albumsCount} альбомов`;
        statsEl.style.color = '#38bdf8';
      } else {
        statsEl.textContent = 'Папка не выбрана. Выберите папку для добавления музыки.';
        statsEl.style.color = 'var(--text-muted)';
      }
    }
  }

  populateProxyUI() {
    const proxy = this.config?.proxy || {};

    const fillService = (service) => {
      const cfg = proxy[service] || {};
      const els = this.proxyEls(service);
      if (els.enable) els.enable.checked = !!cfg.enabled;
      els.card?.classList.toggle('is-enabled', !!cfg.enabled);
      if (els.warn) els.warn.style.display = 'none';

      let host = cfg.host || '';
      let port = cfg.port !== undefined && cfg.port !== null ? String(cfg.port) : '';
      let type = cfg.type || '';
      let user = cfg.username || '';
      let pass = cfg.password || '';

      // If legacy url is present without host
      if (!host && cfg.url) {
        const parsed = this.parsePastedProxy(cfg.url);
        if (parsed) {
          host = parsed.host || '';
          port = parsed.port || '';
          if (parsed.type) type = parsed.type;
          if (parsed.username) user = parsed.username;
          if (parsed.password) pass = parsed.password;
        }
      }

      if (els.address) els.address.value = host ? `${type || 'socks5'}://${host}${port ? ':' + port : ''}` : '';
      if (els.user) els.user.value = user;
      if (els.pass) els.pass.value = pass;
      if (els.auth) els.auth.open = !!user;
      if (cfg.enabled && host) this.setProxyStatus(service, 'Через прокси · нажмите «Проверить», чтобы узнать IP');
      else this.setProxyStatus(service, 'Напрямую');
    };

    fillService('soundcloud');
    fillService('yandex');
  }

  parsePastedProxy(raw) {
    if (!raw || typeof raw !== 'string') return null;
    let str = raw.trim();
    if (!str) return null;

    let type = '';
    let host = '';
    let port = '';
    let username = '';
    let password = '';

    // Check scheme
    const schemeMatch = str.match(/^([a-zA-Z0-9]+):\/\//);
    if (schemeMatch) {
      const proto = schemeMatch[1].toLowerCase();
      if (proto.startsWith('socks5') || proto === 'socks') type = 'socks5';
      else if (proto.startsWith('socks4')) type = 'socks4';
      else if (proto === 'http' || proto === 'https') type = 'http';
      str = str.replace(/^[a-zA-Z0-9]+:\/\//, '');
    }

    // Check user:pass@host:port
    if (str.includes('@')) {
      const atParts = str.split('@');
      const auth = atParts[0].split(':');
      username = decodeURIComponent(auth[0] || '');
      password = decodeURIComponent(auth.slice(1).join(':') || '');
      str = atParts.slice(1).join('@');
    }

    // Check 4-part colon formats: host:port:user:pass OR user:pass:host:port
    const colonParts = str.split(':');
    if (colonParts.length === 4) {
      const p1 = parseInt(colonParts[1], 10);
      const p3 = parseInt(colonParts[3], 10);

      if (!isNaN(p1) && p1 > 0 && p1 <= 65535) {
        // host:port:user:pass
        host = colonParts[0].trim();
        port = String(p1);
        if (!username) username = colonParts[2].trim();
        if (!password) password = colonParts[3].trim();
      } else if (!isNaN(p3) && p3 > 0 && p3 <= 65535) {
        // user:pass:host:port
        if (!username) username = colonParts[0].trim();
        if (!password) password = colonParts[1].trim();
        host = colonParts[2].trim();
        port = String(p3);
      }
    } else if (colonParts.length === 2) {
      host = colonParts[0].trim();
      port = colonParts[1].trim();
    } else {
      host = str.trim();
    }

    // Clean host
    if (host.includes(':')) {
      const sp = host.split(':');
      host = sp[0].trim();
      if (!port) port = sp[1].trim();
    }

    host = host.replace(/^\[|\]$/g, '').trim();

    return { type, host, port, username, password };
  }

  reloadWebview(service) {
    const wv = document.getElementById(`wv-${service}`);
    if (!wv) return;

    if (service === 'soundcloud') {
      const overlay = document.getElementById('soundcloud-error-overlay');
      if (overlay) overlay.style.display = 'none';
    }

    const defaultUrls = {
      soundcloud: 'https://soundcloud.com',
      yandex: 'https://music.yandex.ru'
    };

    if (!this.webviewsLoaded[service]) {
      if (service === 'soundcloud') this.loadSoundcloudWebview();
      else if (service === 'yandex') this.loadYandexWebview();
    } else {
      try {
        let currentUrl = (wv.getURL && wv.getURL()) || wv.src || defaultUrls[service];
        if (!currentUrl || currentUrl === 'about:blank' || !currentUrl.startsWith('http')) {
          currentUrl = defaultUrls[service];
        }
        if (typeof wv.loadURL === 'function') {
          wv.loadURL(currentUrl);
        } else {
          wv.src = currentUrl;
          wv.reload();
        }
      } catch (e) {
        try { wv.reload(); } catch (err) {}
      }
    }
  }

  setupShortcuts() {
    window.addEventListener('keydown', (e) => {
      // Don't trigger if typing in input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      if (e.code === 'Space') {
        e.preventDefault();
        window.localPlayer.togglePlay();
      } else if (e.code === 'ArrowRight' && e.ctrlKey) {
        e.preventDefault();
        window.localPlayer.next();
      } else if (e.code === 'ArrowLeft' && e.ctrlKey) {
        e.preventDefault();
        window.localPlayer.previous();
      }
    });
  }

  showToast(message, type = 'info', duration = 3500) {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    let iconHtml = '<span class="toast-icon">ℹ️</span>';
    if (type === 'success') iconHtml = '<span class="toast-icon">✅</span>';
    else if (type === 'error') iconHtml = '<span class="toast-icon">❌</span>';
    else if (type === 'warning') iconHtml = '<span class="toast-icon">⚠️</span>';
    else if (type === 'loading') iconHtml = '<div class="toast-spinner"></div>';

    toast.innerHTML = `
      ${iconHtml}
      <span class="toast-msg">${message}</span>
    `;

    container.appendChild(toast);

    let dismissTimer = null;

    const closeToast = () => {
      if (dismissTimer) clearTimeout(dismissTimer);
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(12px) scale(0.95)';
      setTimeout(() => {
        try { toast.remove(); } catch (e) {}
      }, 300);
    };

    const updateToast = (newMsg, newType = null) => {
      const msgEl = toast.querySelector('.toast-msg');
      if (msgEl && newMsg) msgEl.textContent = newMsg;
      if (newType && newType !== type) {
        toast.className = `toast toast-${newType}`;
        type = newType;
        let newIcon = '<span class="toast-icon">ℹ️</span>';
        if (newType === 'success') newIcon = '<span class="toast-icon">✅</span>';
        else if (newType === 'error') newIcon = '<span class="toast-icon">❌</span>';
        else if (newType === 'warning') newIcon = '<span class="toast-icon">⚠️</span>';
        else if (newType === 'loading') newIcon = '<div class="toast-spinner"></div>';
        const iconEl = toast.querySelector('.toast-icon, .toast-spinner');
        if (iconEl) {
          iconEl.outerHTML = newIcon;
        }
      }
    };

    if (duration > 0) {
      dismissTimer = setTimeout(closeToast, duration);
    }

    return {
      element: toast,
      update: updateToast,
      close: closeToast
    };
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.appController = new AppController();
});
