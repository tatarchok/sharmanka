/* ==========================================================================
   Universal Multi-Service Audio Player Manager
   ========================================================================== */

class UniversalPlayerManager {
  constructor() {
    this.audio = new Audio();
    this.queue = [];
    this.currentIndex = -1;
    this.isPlaying = false;
    this.isShuffle = false;
    this.repeatMode = 'none'; // 'none' | 'all' | 'one'
    
    // Active playback source: 'local' | 'soundcloud' | 'yandex'
    this.activeSource = 'local';
    this.isDraggingSeek = false;
    this.previousVolume = 0.8;
    this.serviceMetadata = {
      soundcloud: { title: '', artist: '', cover: null, duration: 0, position: 0, isPlaying: false },
      yandex: { title: '', artist: '', cover: null, duration: 0, position: 0, isPlaying: false }
    };

    // Equalizer state & Web Audio nodes
    let initialEq = {
      enabled: true,
      preset: 'flat',
      gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    };
    try {
      const cached = localStorage.getItem('musichub_equalizer');
      if (cached) initialEq = { ...initialEq, ...JSON.parse(cached) };
    } catch (e) {}

    this.equalizer = initialEq;

    // "Previously played" belongs to the current queue: ids of its tracks that were played and left
    this.resetQueueSession();
    // The old app-wide history is no longer used
    try { localStorage.removeItem('musichub_play_history'); } catch (e) {}
    this.eqAudioCtx = null;
    this.eqFilters = [];
    this.eqSourceNode = null;

    this.setupLocalAudioListeners();
    this.setupDownloadListeners();
    this.setupDownloadProgressListener();
    this.setupQueueListeners();
    this.setupOverlaySync();
    this.setupTrackInfoLinks();
  }

  setupTrackInfoLinks() {
    document.getElementById('player-track-title')?.addEventListener('click', () => this.openCurrentSource());
    document.getElementById('player-track-artist')?.addEventListener('click', () => this.openCurrentArtist());
  }

  setupOverlaySync() {
    if (window.api?.overlay?.onControl) {
      window.api.overlay.onControl((action) => {
        if (action === 'toggle') this.togglePlay();
        else if (action === 'next') this.next();
        else if (action === 'prev') this.previous();
      });
    }
  }

  pushOverlayState() {
    if (!window.api?.overlay?.updateTrack) return;
    const titleEl = document.getElementById('player-track-title');
    const artistEl = document.getElementById('player-track-artist');
    const artEl = document.getElementById('player-art-img');

    window.api.overlay.updateTrack({
      title: titleEl?.textContent || '',
      artist: artistEl?.textContent || '',
      cover: (artEl && artEl.style.display !== 'none') ? artEl.src : null,
      isPlaying: this.isPlaying
    });
  }

  setupDownloadListeners() {
    document.getElementById('player-download-btn')?.addEventListener('click', () => {
      if (this.activeSource === 'soundcloud') {
        this.downloadCurrentSoundCloudTrack();
      }
    });
    document.getElementById('btn-sc-download')?.addEventListener('click', () => {
      this.downloadCurrentSoundCloudTrack();
    });
  }

  setupDownloadProgressListener() {
    if (window.api.soundcloud && window.api.soundcloud.onDownloadProgress) {
      window.api.soundcloud.onDownloadProgress((data) => {
        if (!data || !this.currentDownloadToast) return;
        if (data.isAlbum) {
          if (data.current < data.total) {
            this.currentDownloadToast.update(
              `Скачивание альбома «${data.albumTitle}»: трек ${data.current} из ${data.total} (${data.percent}%)...`,
              'loading'
            );
          } else {
            this.currentDownloadToast.update(
              `Финализация альбома «${data.albumTitle}»...`,
              'loading'
            );
          }
        } else if (data.trackTitle) {
          this.currentDownloadToast.update(
            `Скачивание «${data.trackTitle}» (${data.percent || 0}%)...`,
            'loading'
          );
        }
      });
    }
  }

  initEqualizer() {
    if (this.eqAudioCtx) return;
    try {
      this.eqAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
      this.eqFilters = FREQS.map((freq, idx) => {
        const filter = this.eqAudioCtx.createBiquadFilter();
        if (idx === 0) filter.type = 'lowshelf';
        else if (idx === FREQS.length - 1) filter.type = 'highshelf';
        else {
          filter.type = 'peaking';
          filter.Q.value = 1.4;
        }
        filter.frequency.value = freq;
        filter.gain.value = this.equalizer.enabled ? (this.equalizer.gains[idx] || 0) : 0;
        return filter;
      });

      for (let i = 0; i < this.eqFilters.length - 1; i++) {
        this.eqFilters[i].connect(this.eqFilters[i + 1]);
      }
      this.eqFilters[this.eqFilters.length - 1].connect(this.eqAudioCtx.destination);

      this.eqSourceNode = this.eqAudioCtx.createMediaElementSource(this.audio);
      this.eqSourceNode.connect(this.eqFilters[0]);
    } catch (e) {
      console.warn('[LocalPlayer EQ] Error initializing equalizer:', e);
    }
  }

  setEqualizer(config) {
    if (!config) return;
    this.equalizer = {
      ...this.equalizer,
      ...config
    };

    try {
      localStorage.setItem('musichub_equalizer', JSON.stringify(this.equalizer));
    } catch (e) {}

    this.initEqualizer();
    if (this.eqAudioCtx && this.eqAudioCtx.state === 'suspended') {
      this.eqAudioCtx.resume().catch(() => {});
    }

    if (this.eqFilters && this.eqFilters.length) {
      this.eqFilters.forEach((filter, idx) => {
        try {
          filter.gain.value = this.equalizer.enabled ? (this.equalizer.gains[idx] || 0) : 0;
        } catch (e) {}
      });
    }

    // Broadcast to all webviews
    this.sendWebviewCommand('wv-soundcloud', 'setEqualizer', this.equalizer);
    this.sendWebviewCommand('wv-yandex', 'setEqualizer', this.equalizer);

    // Persist in config
    if (window.appController && window.appController.config) {
      if (!window.appController.config.settings) window.appController.config.settings = {};
      window.appController.config.settings.equalizer = this.equalizer;
      window.api.library.saveConfig(window.appController.config).catch(() => {});
    }
  }

  setupLocalAudioListeners() {
    this.audio.addEventListener('play', () => {
      this.activeSource = 'local';
      this.isPlaying = true;
      this.pauseAllExcept('local');
      this.updatePlayStateUI(true);
      this.updateSourceBadge('local');
      this.updateMediaSession();
    });

    this.audio.addEventListener('pause', () => {
      if (this.activeSource === 'local') {
        this.isPlaying = false;
        this.updatePlayStateUI(false);
      }
    });

    this.audio.addEventListener('timeupdate', () => {
      if (this.activeSource === 'local' && !isNaN(this.audio.duration) && this.audio.duration > 0) {
        const progress = (this.audio.currentTime / this.audio.duration) * 100;
        this.updateProgressUI(this.audio.currentTime, this.audio.duration, progress);
      }
    });

    this.audio.addEventListener('ended', () => {
      if (this.activeSource === 'local') {
        if (this.repeatMode === 'one') {
          this.audio.currentTime = 0;
          this.audio.play();
        } else {
          this.next();
        }
      }
    });

    this.audio.addEventListener('error', (e) => {
      if (this.activeSource === 'local') {
        console.warn('Local audio playback error:', e);
        this.isPlaying = false;
        this.updatePlayStateUI(false);
      }
    });
  }

  // Prevents multiple platforms from playing sound at the same time
  pauseAllExcept(source) {
    if (source !== 'local' && this.audio && !this.audio.paused) {
      this.audio.pause();
    }

    if (source !== 'soundcloud') {
      if (this.serviceMetadata.soundcloud) {
        this.serviceMetadata.soundcloud.isPlaying = false;
      }
      this.sendWebviewCommand('wv-soundcloud', 'pause');
    }

    if (source !== 'yandex') {
      if (this.serviceMetadata.yandex) {
        this.serviceMetadata.yandex.isPlaying = false;
      }
      this.sendWebviewCommand('wv-yandex', 'pause');
    }
  }

  sendWebviewCommand(webviewId, command, arg = null) {
    const wv = document.getElementById(webviewId);
    if (!wv) return;

    try {
      if (!wv.src || !wv.getWebContentsId || typeof wv.executeJavaScript !== 'function') return;
      if (!wv.src.startsWith('http')) return;
      if (wv.isLoading && wv.isLoading()) return;
    } catch (e) {
      return;
    }

    try {
      let code = '';
      if (command === 'pause') {
        code = `
          if (window.musicHubBridge && typeof window.musicHubBridge.pause === 'function') {
            window.musicHubBridge.pause();
          } else {
            document.querySelectorAll('audio, video').forEach(el => { try { el.pause(); } catch(e){} });
          }
        `;
      } else if (command === 'setVolume') {
        code = `
          if (window.musicHubBridge && typeof window.musicHubBridge.setVolume === 'function') {
            window.musicHubBridge.setVolume(${JSON.stringify(arg)});
          } else {
            document.querySelectorAll('audio, video').forEach(el => { try { el.volume = ${JSON.stringify(arg)}; } catch(e){} });
          }
        `;
      } else if (arg !== null) {
        code = `if (window.musicHubBridge && typeof window.musicHubBridge.${command} === 'function') window.musicHubBridge.${command}(${JSON.stringify(arg)});`;
      } else {
        code = `if (window.musicHubBridge && typeof window.musicHubBridge.${command} === 'function') window.musicHubBridge.${command}();`;
      }
      wv.executeJavaScript(code).catch(() => {});
    } catch (e) {
      // ignore
    }
  }

  // Handle messages coming from webviews
  handleServiceBridgeMessage(service, event, data) {
    if (!this.serviceMetadata[service]) return;

    // Spectrum for the animated background (~30 times a second)
    if (event === 'levels') {
      window.bgVisualizer?.pushServiceLevels(service, data && data.b);
      return;
    }

    if (event === 'track') {
      this.serviceMetadata[service] = {
        ...this.serviceMetadata[service],
        ...data
      };

      // ONLY update player bar UI if this service is currently the active source
      if (this.activeSource === service) {
        this.updateExternalTrackInfoUI(service, this.serviceMetadata[service]);
        this.refreshQueueIfOpen();
      }
      if (this.equalizer) {
        this.sendWebviewCommand(`wv-${service}`, 'setEqualizer', this.equalizer);
      }
    } else if (event === 'like') {
      // null = the site shows no like button (nothing loaded, not signed in)
      this.serviceMetadata[service].liked = data ? data.liked : null;
      if (this.activeSource === service) this.updateServiceLikeButton(service);
    } else if (event === 'state') {
      const isPlaying = Boolean(data.isPlaying);
      this.serviceMetadata[service].isPlaying = isPlaying;

      if (isPlaying) {
        // Service actively started playback
        const sourceChanged = this.activeSource !== service;
        this.activeSource = service;
        this.isPlaying = true;
        this.pauseAllExcept(service);
        this.updatePlayStateUI(true);
        this.updateSourceBadge(service);
        this.updateExternalTrackInfoUI(service, this.serviceMetadata[service]);
        // Reading a service queue opens its panel — only do it when the source changed
        if (sourceChanged) this.refreshQueueIfOpen();
        this.setVolume(this.audio.volume || 0.8);
        if (this.equalizer) {
          this.sendWebviewCommand(`wv-${service}`, 'setEqualizer', this.equalizer);
        }
      } else {
        if (this.activeSource === service) {
          this.isPlaying = false;
          this.updatePlayStateUI(false);
        }
      }
    } else if (event === 'progress') {
      // Progress events must ONLY update progress UI for the active service and NEVER switch activeSource
      if (this.activeSource === service && data.duration > 0) {
        const progress = Math.min(100, Math.max(0, (data.position / data.duration) * 100));
        this.updateProgressUI(data.position, data.duration, progress);
      }
    } else if (event === 'repeat') {
      if (this.activeSource === service && data.mode) {
        this.repeatMode = data.mode;
        this.updateRepeatUI();
      }
    } else if (event === 'shuffle') {
      if (this.activeSource === service && typeof data.isShuffle === 'boolean') {
        this.isShuffle = data.isShuffle;
        const btn = document.getElementById('ctrl-shuffle');
        if (btn) {
          btn.classList.toggle('active', this.isShuffle);
          btn.title = this.isShuffle ? 'Перемешивание: Включено' : 'Перемешивание: Выключено';
        }
      }
    } else if (event === 'downloadTrack' || event === 'download-track') {
      if (data && data.url) {
        this.downloadSoundCloudTrackByUrl(data.url, data.title);
      }
    }
  }

  // Local track management
  setQueue(tracks, startIndex = 0) {
    this.queue = [...tracks];
    this.resetQueueSession();
    if (startIndex >= 0 && startIndex < this.queue.length) {
      this.currentIndex = startIndex;
      if (this.isShuffle) this.applyLocalShuffle();
      this.playCurrent();
    } else {
      this.currentIndex = -1;
      this.renderQueueUI();
    }
  }

  playNext(track) {
    if (!track) return;
    if (this.queue.length === 0 || this.currentIndex === -1) {
      this.setQueue([track], 0);
    } else {
      const insertIndex = this.currentIndex + 1;
      this.queue.splice(insertIndex, 0, track);
      this.renderQueueUI();
      const title = track.artist ? `${track.artist} - ${track.title}` : (track.title || track.filename);
      window.appController?.showToast(`«${title}» будет воспроизведен следующим`, 'info');
    }
  }

  addToQueue(track) {
    if (!track) return;
    if (this.queue.length === 0 || this.currentIndex === -1) {
      this.setQueue([track], 0);
    } else {
      this.queue.push(track);
      this.renderQueueUI();
      const title = track.artist ? `${track.artist} - ${track.title}` : (track.title || track.filename);
      window.appController?.showToast(`«${title}» добавлен в очередь`, 'info');
    }
  }

  removeFromQueue(index) {
    if (index < 0 || index >= this.queue.length) return;

    if (index === this.currentIndex) {
      if (this.queue.length <= 1) {
        this.queue = [];
        this.currentIndex = -1;
        this.audio.pause();
        this.audio.src = '';
        this.isPlaying = false;
        this.updatePlayStateUI(false);
      } else {
        this.next();
        const removeIdx = index < this.currentIndex ? index : index;
        this.queue.splice(removeIdx, 1);
        if (this.currentIndex > 0) this.currentIndex--;
      }
    } else if (index < this.currentIndex) {
      this.queue.splice(index, 1);
      this.currentIndex--;
    } else {
      this.queue.splice(index, 1);
    }

    this.renderQueueUI();
    if (window.libraryUI) {
      window.libraryUI.highlightCurrentPlayingTrack();
    }
  }

  moveInQueue(fromIndex, toIndex) {
    if (fromIndex < 0 || fromIndex >= this.queue.length || toIndex < 0 || toIndex >= this.queue.length || fromIndex === toIndex) return;

    const [movedItem] = this.queue.splice(fromIndex, 1);
    this.queue.splice(toIndex, 0, movedItem);

    if (this.currentIndex === fromIndex) {
      this.currentIndex = toIndex;
    } else if (fromIndex < this.currentIndex && toIndex >= this.currentIndex) {
      this.currentIndex--;
    } else if (fromIndex > this.currentIndex && toIndex <= this.currentIndex) {
      this.currentIndex++;
    }

    this.renderQueueUI();
  }

  clearQueue() {
    if (this.currentIndex >= 0 && this.currentIndex < this.queue.length) {
      const current = this.queue[this.currentIndex];
      this.queue = [current];
      this.currentIndex = 0;
      this.passedTrackIds = new Set();
      window.appController?.showToast('Очередь воспроизведения очищена', 'info');
    } else {
      this.queue = [];
      this.currentIndex = -1;
      this.audio.pause();
      this.audio.src = '';
      this.isPlaying = false;
      this.updatePlayStateUI(false);
    }
    this.renderQueueUI();
  }

  setupQueueListeners() {
    const toggleBtn = document.getElementById('btn-toggle-queue');
    const closeBtn = document.getElementById('btn-close-queue');
    const clearBtn = document.getElementById('btn-clear-queue');
    const drawer = document.getElementById('queue-drawer');

    if (toggleBtn && drawer) {
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (drawer.classList.contains('active')) {
          drawer.classList.remove('active');
          toggleBtn.classList.remove('active');
        } else {
          this.openQueueDrawer();
        }
      });
    }

    if (closeBtn && drawer) {
      closeBtn.addEventListener('click', () => {
        drawer.classList.remove('active');
        toggleBtn?.classList.remove('active');
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        this.clearQueue();
      });
    }

    // Close on outside click
    window.addEventListener('click', (e) => {
      if (drawer && drawer.classList.contains('active')) {
        // composedPath still contains the drawer even if the clicked row was re-rendered away
        const path = e.composedPath ? e.composedPath() : [];
        if (!path.includes(drawer) && !drawer.contains(e.target) && !toggleBtn?.contains(e.target)) {
          drawer.classList.remove('active');
          toggleBtn?.classList.remove('active');
        }
      }
    });
  }

  // ==========================================
  // Queue drawer rendering
  // ==========================================
  queueEls() {
    return {
      badge: document.getElementById('queue-count-badge'),
      npContainer: document.getElementById('queue-now-playing-card'),
      npSection: document.getElementById('queue-section-now-playing'),
      context: document.getElementById('queue-context'),
      upNextContainer: document.getElementById('queue-list-container'),
      upNextSection: document.getElementById('queue-section-up-next'),
      emptyState: document.getElementById('queue-empty-state'),
      historySection: document.getElementById('queue-section-history'),
      historyContainer: document.getElementById('queue-history-container'),
      clearQueueBtn: document.getElementById('btn-clear-queue')
    };
  }

  // After opening the drawer: current track near the top, one played track visible above it
  scrollQueueToCurrent() {
    const content = document.getElementById('queue-content');
    const card = document.getElementById('queue-section-now-playing');
    if (!content || !card || card.style.display === 'none') return;
    content.scrollTop = Math.max(0, card.offsetTop - content.offsetTop - 56);
  }

  afterQueueRender() {
    if (this.scrollToCurrentPending) {
      this.scrollToCurrentPending = false;
      this.scrollQueueToCurrent();
    }
  }

  escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  queueThumbHtml(cls, src, size) {
    if (src) return `<img class="${cls}" src="${this.escapeHtml(src)}" alt="" />`;
    return `<div class="${cls} queue-thumb-empty"><svg xmlns="http://www.w3.org/2000/svg" height="${size}px" viewBox="0 -960 960 960" width="${size}px" fill="currentColor"><path d="M400-120q-66 0-113-47t-47-113q0-66 47-113t113-47q23 0 42.5 5.5T480-418v-422h240v160H560v400q0 66-47 113t-113 47Z"/></svg></div>`;
  }

  // A plain (non-draggable) queue row: history items and streaming-service queues
  buildSimpleQueueRow({ cover, title, artist, duration, played, onPlay, onRemove, playTitle }) {
    const itemEl = document.createElement('div');
    itemEl.className = 'queue-item' + (played ? ' queue-item-history' : ' queue-item-clickable');
    itemEl.title = playTitle || 'Воспроизвести';
    itemEl.innerHTML = `
      <div class="queue-history-thumb-wrap">
        ${this.queueThumbHtml('queue-thumb', cover, 16)}
        <div class="queue-history-replay">
          <svg xmlns="http://www.w3.org/2000/svg" height="18px" viewBox="0 -960 960 960" width="18px" fill="currentColor"><path d="M320-200v-560l440 280-440 280Z"/></svg>
        </div>
      </div>
      <div class="queue-item-info">
        <span class="queue-item-title">${this.escapeHtml(title)}</span>
        <span class="queue-item-artist">${this.escapeHtml(artist || 'Неизвестный исполнитель')}</span>
      </div>
      <span class="queue-item-time">${duration ? this.formatTime(duration) : ''}</span>
      ${onRemove ? `
      <div class="queue-item-actions">
        <button class="queue-btn-action delete" title="Убрать из очереди">
          <svg xmlns="http://www.w3.org/2000/svg" height="14px" viewBox="0 -960 960 960" width="14px" fill="currentColor"><path d="m256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z"/></svg>
        </button>
      </div>` : ''}
    `;
    itemEl.addEventListener('click', () => onPlay && onPlay());
    if (onRemove) {
      itemEl.querySelector('.queue-btn-action.delete').addEventListener('click', (e) => {
        e.stopPropagation();
        onRemove();
      });
    }
    return itemEl;
  }

  renderNowPlayingCard(current, sourceLabel) {
    const { npContainer, npSection } = this.queueEls();
    if (!npContainer || !npSection) return;
    if (!current) {
      npSection.style.display = 'none';
      return;
    }
    npSection.style.display = 'flex';
    const animHtml = `<div class="queue-np-anim${this.isPlaying ? '' : ' paused'}"><span></span><span></span><span></span><span></span></div>`;
    const badge = sourceLabel
      ? `<span class="queue-np-source source-${this.escapeHtml(this.activeSource)}">${this.escapeHtml(sourceLabel)}</span>`
      : '';
    npContainer.innerHTML = `
      ${this.queueThumbHtml('queue-np-thumb', current.cover, 20)}
      <div class="queue-np-info">
        <span class="queue-np-title" title="${this.escapeHtml(current.title)}">${this.escapeHtml(current.title)}</span>
        <span class="queue-np-artist" title="${this.escapeHtml(current.artist)}">${this.escapeHtml(current.artist)}</span>
        ${badge}
      </div>
      ${animHtml}
    `;
  }

  renderQueueUI() {
    if (this.activeSource === 'soundcloud' || this.activeSource === 'yandex') {
      this.renderServiceQueue(this.activeSource);
    } else {
      this.renderLocalQueue();
      this.afterQueueRender();
    }
  }

  // ---- Local library queue ---------------------------------------------------
  renderLocalQueue() {
    const els = this.queueEls();
    const { badge, upNextContainer, upNextSection, emptyState, historySection, historyContainer } = els;
    if (!badge || !upNextContainer) return;
    this.serviceQueueToken = (this.serviceQueueToken || 0) + 1; // cancel pending service renders

    if (els.context) els.context.textContent = '';
    if (els.clearQueueBtn) els.clearQueueBtn.style.display = '';

    const t = this.queue[this.currentIndex];
    const current = t ? { title: t.title || t.filename, artist: t.artist || 'Неизвестный исполнитель', cover: t.coverArt || null } : null;

    // Previously played = tracks of THIS queue that were played and left behind
    const history = [];
    for (let i = 0; i < this.currentIndex; i++) {
      if (this.passedTrackIds.has(this.queue[i].id)) history.push(i);
    }

    const upcomingCount = Math.max(0, this.queue.length - (this.currentIndex + 1));
    badge.textContent = upcomingCount;
    badge.title = 'Треков далее в очереди';

    if (!current && history.length === 0 && upcomingCount === 0) {
      if (historySection) historySection.style.display = 'none';
      this.renderNowPlayingCard(null);
      if (upNextSection) upNextSection.style.display = 'none';
      if (emptyState) emptyState.style.display = 'flex';
      return;
    }
    if (emptyState) emptyState.style.display = 'none';

    // 0. Previously played
    if (historySection && historyContainer) {
      historySection.style.display = history.length ? 'flex' : 'none';
      historyContainer.innerHTML = '';
      history.forEach(index => {
        const track = this.queue[index];
        historyContainer.appendChild(this.buildSimpleQueueRow({
          cover: track.coverArt,
          title: track.title || track.filename,
          artist: track.artist,
          duration: track.duration,
          played: true,
          playTitle: 'Воспроизвести снова',
          onPlay: () => this.playIndex(index)
        }));
      });
    }

    // 1. Now playing
    this.renderNowPlayingCard(current);

    // 2. Up next
    if (upcomingCount <= 0) {
      if (upNextSection) upNextSection.style.display = 'none';
      upNextContainer.innerHTML = '';
      return;
    }
    if (upNextSection) upNextSection.style.display = 'flex';
    upNextContainer.innerHTML = '';

    const esc = (s) => this.escapeHtml(s);
    let draggedItemIndex = null;

    for (let i = this.currentIndex + 1; i < this.queue.length; i++) {
      const track = this.queue[i];
      const realIndex = i;

      const itemEl = document.createElement('div');
      itemEl.className = 'queue-item';
      itemEl.draggable = true;
      itemEl.dataset.queueIndex = realIndex;

      const isFirstUpcoming = realIndex === this.currentIndex + 1;
      const isLastUpcoming = realIndex === this.queue.length - 1;

      itemEl.innerHTML = `
        <div class="queue-drag-handle" title="Перетащите для изменения порядка">
          <svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 -960 960 960" width="16px" fill="currentColor">
            <path d="M360-160q-33 0-56.5-23.5T280-240q0-33 23.5-56.5T360-320q33 0 56.5 23.5T440-240q0 33-23.5 56.5T360-160Zm240 0q-33 0-56.5-23.5T520-240q0-33 23.5-56.5T600-320q33 0 56.5 23.5T680-240q0 33-23.5 56.5T600-160ZM360-400q-33 0-56.5-23.5T280-480q0-33 23.5-56.5T360-560q33 0 56.5 23.5T440-480q0 33-23.5 56.5T360-400Zm240 0q-33 0-56.5-23.5T520-480q0-33 23.5-56.5T600-560q33 0 56.5 23.5T680-480q0 33-23.5 56.5T600-400ZM360-640q-33 0-56.5-23.5T280-720q0-33 23.5-56.5T360-800q33 0 56.5 23.5T440-720q0 33-23.5 56.5T360-640Zm240 0q-33 0-56.5-23.5T520-720q0-33 23.5-56.5T600-800q33 0 56.5 23.5T680-720q0 33-23.5 56.5T600-640Z"/>
          </svg>
        </div>
        ${this.queueThumbHtml('queue-thumb', track.coverArt, 16)}
        <div class="queue-item-info" title="Воспроизвести сейчас">
          <span class="queue-item-title">${esc(track.title || track.filename)}</span>
          <span class="queue-item-artist">${esc(track.artist || 'Неизвестный исполнитель')}</span>
        </div>
        <span class="queue-item-time">${this.formatTime(track.duration)}</span>
        <div class="queue-item-actions">
          <button class="queue-btn-action btn-move-up" title="Переместить выше" ${isFirstUpcoming ? 'style="opacity: 0.2; pointer-events: none;"' : ''}>
            <svg xmlns="http://www.w3.org/2000/svg" height="14px" viewBox="0 -960 960 960" width="14px" fill="currentColor"><path d="m280-400 200-200 200 200H280Z"/></svg>
          </button>
          <button class="queue-btn-action btn-move-down" title="Переместить ниже" ${isLastUpcoming ? 'style="opacity: 0.2; pointer-events: none;"' : ''}>
            <svg xmlns="http://www.w3.org/2000/svg" height="14px" viewBox="0 -960 960 960" width="14px" fill="currentColor"><path d="M480-360 280-560h400L480-360Z"/></svg>
          </button>
          <button class="queue-btn-action delete btn-remove-queue" title="Убрать из очереди">
            <svg xmlns="http://www.w3.org/2000/svg" height="14px" viewBox="0 -960 960 960" width="14px" fill="currentColor"><path d="m256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z"/></svg>
          </button>
        </div>
      `;

      itemEl.querySelector('.queue-item-info').addEventListener('click', () => this.playIndex(realIndex));
      itemEl.querySelector('.btn-move-up')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (realIndex > this.currentIndex + 1) this.moveInQueue(realIndex, realIndex - 1);
      });
      itemEl.querySelector('.btn-move-down')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (realIndex < this.queue.length - 1) this.moveInQueue(realIndex, realIndex + 1);
      });
      itemEl.querySelector('.btn-remove-queue')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removeFromQueue(realIndex);
      });

      itemEl.addEventListener('dragstart', (e) => {
        draggedItemIndex = realIndex;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', realIndex);
        setTimeout(() => itemEl.classList.add('dragging'), 0);
      });
      itemEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        itemEl.classList.add('drag-over');
      });
      itemEl.addEventListener('dragleave', () => itemEl.classList.remove('drag-over'));
      itemEl.addEventListener('drop', (e) => {
        e.preventDefault();
        itemEl.classList.remove('drag-over');
        if (draggedItemIndex !== null && draggedItemIndex !== realIndex) this.moveInQueue(draggedItemIndex, realIndex);
      });
      itemEl.addEventListener('dragend', () => {
        itemEl.classList.remove('dragging');
        document.querySelectorAll('.queue-item').forEach(el => el.classList.remove('drag-over'));
      });

      upNextContainer.appendChild(itemEl);
    }
  }

  // ---- SoundCloud / Yandex Music queue (read from the service's own player) ----
  async renderServiceQueue(service) {
    const els = this.queueEls();
    const { badge, upNextContainer, upNextSection, emptyState, historySection, historyContainer } = els;
    if (!badge || !upNextContainer) return;
    const token = this.serviceQueueToken = (this.serviceQueueToken || 0) + 1;
    const sourceLabel = service === 'soundcloud' ? 'SoundCloud' : 'Яндекс Музыка';

    // Streaming queues are managed by the service itself
    if (els.clearQueueBtn) els.clearQueueBtn.style.display = 'none';
    if (emptyState) emptyState.style.display = 'none';

    // Show what we already know right away, the full queue follows
    const meta = this.serviceMetadata[service] || {};
    if (meta.title) this.renderNowPlayingCard({ title: meta.title, artist: meta.artist || '', cover: meta.cover || null }, sourceLabel);
    if (!this.lastServiceQueue || this.lastServiceQueue.service !== service) {
      if (historySection) historySection.style.display = 'none';
      if (upNextSection) upNextSection.style.display = 'flex';
      upNextContainer.innerHTML = '<div class="queue-loading">Загрузка очереди…</div>';
    }

    const queue = await this.callWebview(service, 'getQueue');
    if (token !== this.serviceQueueToken || this.activeSource !== service) return;
    this.lastServiceQueue = { service, queue };

    if (!queue) {
      if (historySection) historySection.style.display = 'none';
      if (upNextSection) upNextSection.style.display = 'flex';
      upNextContainer.innerHTML = `<div class="queue-loading">Не удалось получить очередь ${service === 'soundcloud' ? 'SoundCloud' : 'Яндекс Музыки'}. Откройте вкладку сервиса и включите трек.</div>`;
      badge.textContent = '0';
      return;
    }

    const refreshSoon = () => setTimeout(() => this.refreshQueueIfOpen(), 1200);
    const play = (key) => this.callWebview(service, 'playQueueItem', key).then(refreshSoon);

    // Where the queue comes from ("Сейчас играет из плейлиста Чарт", "From <playlist>")
    const context = String(queue.context || '')
      .replace(/^Сейчас играет из (плейлиста|альбома)\s*/i, '')
      .replace(/^From\s+/i, '');
    if (els.context) els.context.textContent = context ? `${sourceLabel} · ${context}` : sourceLabel;

    // 0. Previously played in this playlist/album
    const history = (queue.history || []).slice(-50);
    if (historySection && historyContainer) {
      historySection.style.display = history.length ? 'flex' : 'none';
      historyContainer.innerHTML = '';
      history.forEach(item => historyContainer.appendChild(this.buildSimpleQueueRow({
        ...item,
        played: true,
        playTitle: 'Воспроизвести снова',
        onPlay: () => play(item.key)
      })));
    }

    // 1. Now playing
    const current = queue.current || (meta.title ? { title: meta.title, artist: meta.artist, cover: meta.cover } : null);
    this.renderNowPlayingCard(current ? { title: current.title, artist: current.artist || '', cover: current.cover || meta.cover || null } : null, sourceLabel);

    // 2. Up next
    const upcoming = queue.upcoming || [];
    badge.textContent = upcoming.length;
    badge.title = 'Треков далее в очереди';
    upNextContainer.innerHTML = '';
    if (upNextSection) upNextSection.style.display = upcoming.length ? 'flex' : 'none';
    upcoming.forEach(item => upNextContainer.appendChild(this.buildSimpleQueueRow({
      ...item,
      played: false,
      playTitle: 'Воспроизвести сейчас',
      onPlay: () => play(item.key),
      onRemove: item.removable
        ? () => this.callWebview(service, 'removeQueueItem', item.key).then(() => this.refreshQueueIfOpen())
        : null
    })));

    if (!history.length && !current && !upcoming.length && emptyState) emptyState.style.display = 'flex';
    this.afterQueueRender();
  }

  playTrack(track, trackList = null) {
    if (!track) return;

    const currentTrack = this.queue[this.currentIndex];
    // If clicking the current track that is already loaded in local source:
    if (this.activeSource === 'local' && currentTrack && currentTrack.id === track.id) {
      if (this.isPlaying && !this.audio.paused) {
        this.audio.pause();
      } else {
        this.pauseAllExcept('local');
        this.initEqualizer();
        if (this.eqAudioCtx && this.eqAudioCtx.state === 'suspended') {
          this.eqAudioCtx.resume().catch(() => {});
        }
        this.audio.play().catch(() => {});
      }
      return;
    }

    this.activeSource = 'local';
    this.pauseAllExcept('local');

    if (trackList) {
      // Starting a list (album, playlist, library) = a new queue with an empty history
      this.queue = [...trackList];
      this.resetQueueSession();
      const idx = this.queue.findIndex(t => t.id === track.id);
      this.currentIndex = idx !== -1 ? idx : 0;
      if (this.isShuffle) this.applyLocalShuffle();
    } else {
      if (!this.queue.some(t => t.id === track.id)) {
        this.queue.push(track);
      }
      this.currentIndex = this.queue.findIndex(t => t.id === track.id);
    }
    this.playCurrent();
  }

  playIndex(index) {
    if (index >= 0 && index < this.queue.length) {
      this.currentIndex = index;
      this.playCurrent();
    }
  }

  getTrackFileUrl(filePath) {
    if (!filePath) return '';
    // Tracks on the network storage are already HTTP URLs (auth is added by the main process)
    if (/^https?:\/\//i.test(filePath)) return filePath;
    const normalized = filePath.replace(/\\/g, '/');
    const parts = normalized.split('/');
    const encodedParts = parts.map((part, idx) => {
      if (idx === 0 && /^[a-zA-Z]:$/.test(part)) return part;
      return encodeURIComponent(part);
    });
    return 'file:///' + encodedParts.join('/');
  }

  playCurrent() {
    const track = this.queue[this.currentIndex];
    if (!track) return;

    this.activeSource = 'local';
    this.isPlaying = true;
    this.pauseAllExcept('local');

    const fileUrl = this.getTrackFileUrl(track.filePath);
    if (this.audio.src !== fileUrl) {
      // Remote (HTTP) audio must be CORS-enabled, otherwise the equalizer's Web Audio graph
      // would output silence for it. Local file:// playback keeps working without it.
      const isRemote = /^https?:\/\//i.test(fileUrl);
      if (isRemote) this.audio.crossOrigin = 'anonymous';
      else this.audio.removeAttribute('crossorigin');
      this.audio.src = fileUrl;
    }
    this.audio.currentTime = 0;
    this.initEqualizer();
    if (this.eqAudioCtx && this.eqAudioCtx.state === 'suspended') {
      this.eqAudioCtx.resume().catch(() => {});
    }

    this.audio.play().catch(err => {
      console.error('Local play failed:', err);
    });

    this.updateTrackInfoUI(track);
    this.updateProgressUI(0, track.duration || 0, 0);
    this.updatePlayStateUI(true);
    this.updateSourceBadge('local');
    this.highlightCurrentTrackInTable(track.id);
    // The track we are leaving becomes "previously played"; the new one is current, not history
    if (this.lastPlayedTrackId && this.lastPlayedTrackId !== track.id) {
      this.passedTrackIds.add(this.lastPlayedTrackId);
    }
    this.passedTrackIds.delete(track.id);
    this.lastPlayedTrackId = track.id;
    this.renderQueueUI();
  }

  // ==========================================
  // Queue helpers
  // ==========================================
  // A new queue starts with an empty "previously played" list
  resetQueueSession() {
    this.passedTrackIds = new Set();
    this.lastPlayedTrackId = null;
    this.unshuffledOrder = null;
  }

  static shuffleArray(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Shuffle reorders the upcoming part of the queue, so the drawer shows the real play order.
  // Turning it off restores the original order of the remaining tracks.
  applyLocalShuffle() {
    if (this.currentIndex < 0 || this.queue.length < 2) return;
    const head = this.queue.slice(0, this.currentIndex + 1);
    let tail = this.queue.slice(this.currentIndex + 1);
    if (this.isShuffle) {
      if (!this.unshuffledOrder) this.unshuffledOrder = this.queue.map(t => t.id);
      tail = UniversalPlayerManager.shuffleArray(tail);
    } else if (this.unshuffledOrder) {
      const pos = new Map(this.unshuffledOrder.map((id, i) => [id, i]));
      tail.sort((a, b) => (pos.has(a.id) ? pos.get(a.id) : 1e9) - (pos.has(b.id) ? pos.get(b.id) : 1e9));
      this.unshuffledOrder = null;
    }
    this.queue = head.concat(tail);
    this.renderQueueUI();
  }

  // Shuffled queue from a list of tracks, starting right away ("Вперемешку" in the library)
  playShuffled(tracks) {
    const list = (tracks || []).filter(Boolean);
    if (!list.length) return;
    this.setQueue(UniversalPlayerManager.shuffleArray(list), 0);
    this.openQueueDrawer();
  }

  openQueueDrawer() {
    const drawer = document.getElementById('queue-drawer');
    const toggleBtn = document.getElementById('btn-toggle-queue');
    if (!drawer) return;
    window.appController?.closeEqualizerPanel?.(); // the two popovers share the same spot
    drawer.classList.add('active');
    toggleBtn?.classList.add('active');
    this.scrollToCurrentPending = true;
    this.renderQueueUI();
  }

  // Call a bridge method inside a service webview and get its (awaited) result
  async callWebview(service, method, arg) {
    const wv = document.getElementById(`wv-${service}`);
    if (!wv || !wv.src || typeof wv.executeJavaScript !== 'function') return null;
    const argCode = arg === undefined ? '' : JSON.stringify(arg);
    const code = `(window.musicHubBridge && typeof window.musicHubBridge.${method} === 'function') ? window.musicHubBridge.${method}(${argCode}) : null`;
    try {
      return await wv.executeJavaScript(code);
    } catch (e) {
      return null;
    }
  }

  refreshQueueIfOpen() {
    if (!document.getElementById('queue-drawer')?.classList.contains('active')) return;
    if (this.activeSource === 'local') {
      this.renderQueueUI();
      return;
    }
    // Service queues are read from the service page: coalesce bursts of track/state events
    clearTimeout(this.serviceQueueRefreshTimer);
    this.serviceQueueRefreshTimer = setTimeout(() => this.renderQueueUI(), 600);
  }

  // Controls router
  togglePlay() {
    if (this.activeSource === 'local') {
      if (!this.audio.src || this.currentIndex === -1) {
        if (this.queue.length > 0) this.playIndex(0);
        return;
      }
      this.initEqualizer();
      if (this.eqAudioCtx && this.eqAudioCtx.state === 'suspended') {
        this.eqAudioCtx.resume().catch(() => {});
      }
      if (this.audio.paused) {
        this.pauseAllExcept('local');
        this.audio.play();
      } else {
        this.audio.pause();
      }
    } else if (this.activeSource === 'soundcloud') {
      this.sendWebviewCommand('wv-soundcloud', 'toggle');
    } else if (this.activeSource === 'yandex') {
      this.sendWebviewCommand('wv-yandex', 'toggle');
    }
  }

  next() {
    if (this.activeSource === 'local') {
      if (this.queue.length === 0) return;
      // Shuffle already reordered the queue, so "next" is always the next item in it
      if (this.currentIndex + 1 < this.queue.length) {
        this.currentIndex++;
      } else if (this.repeatMode === 'all') {
        this.currentIndex = 0;
      } else {
        return;
      }
      this.playCurrent();
    } else if (this.activeSource === 'soundcloud') {
      this.sendWebviewCommand('wv-soundcloud', 'next');
    } else if (this.activeSource === 'yandex') {
      this.sendWebviewCommand('wv-yandex', 'next');
    }
  }

  previous() {
    if (this.activeSource === 'local') {
      if (this.queue.length === 0) return;
      if (this.audio.currentTime > 3) {
        this.audio.currentTime = 0;
        return;
      }
      if (this.currentIndex > 0) {
        this.currentIndex--;
      } else if (this.repeatMode === 'all') {
        this.currentIndex = this.queue.length - 1;
      }
      this.playCurrent();
    } else if (this.activeSource === 'soundcloud') {
      this.sendWebviewCommand('wv-soundcloud', 'prev');
    } else if (this.activeSource === 'yandex') {
      this.sendWebviewCommand('wv-yandex', 'prev');
    }
  }

  seek(percentage) {
    if (this.activeSource === 'local') {
      if (!isNaN(this.audio.duration) && this.audio.duration > 0) {
        this.audio.currentTime = (percentage / 100) * this.audio.duration;
      }
    } else if (this.activeSource === 'soundcloud') {
      this.sendWebviewCommand('wv-soundcloud', 'seek', percentage);
    } else if (this.activeSource === 'yandex') {
      this.sendWebviewCommand('wv-yandex', 'seek', percentage);
    }
  }

  setVolume(val) {
    const vol = Math.max(0, Math.min(1, val));
    if (vol > 0) {
      this.previousVolume = vol;
    }
    this.audio.volume = vol;

    const volSlider = document.getElementById('vol-slider');
    if (volSlider) {
      volSlider.value = vol;
      const pct = (vol * 100).toFixed(1);
      volSlider.style.setProperty('--vol-percent', `${pct}%`);
    }

    this.updateVolumeIconUI(vol);
    window.dispatchEvent(new CustomEvent('musichub:volume', { detail: { volume: vol } }));

    this.sendWebviewCommand('wv-yandex', 'setVolume', vol);
    this.sendWebviewCommand('wv-soundcloud', 'setVolume', vol);
  }

  toggleMute() {
    const curVol = typeof this.audio.volume === 'number' ? this.audio.volume : 0.8;
    if (curVol > 0) {
      this.previousVolume = curVol;
      this.setVolume(0);
    } else {
      const restoreVol = (typeof this.previousVolume === 'number' && this.previousVolume > 0) ? this.previousVolume : 0.8;
      this.setVolume(restoreVol);
    }
    if (window.appController?.config) {
      window.appController.config.volume = this.audio.volume;
      window.api.library.saveConfig(window.appController.config).catch(() => {});
    }
  }

  updateVolumeIconUI(vol) {
    const iconBtn = document.getElementById('btn-volume-icon');
    if (!iconBtn) return;

    if (vol === 0) {
      // Muted Icon (speaker with slash / cross)
      iconBtn.title = 'Включить звук';
      iconBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" height="18px" viewBox="0 -960 960 960" width="18px" fill="currentColor">
          <path d="m664-328-56-56 80-80-80-80 56-56 80 80 80-80 56 56-80 80 80 80-56 56-80-80-80 80ZM120-360v-240h160l200-200v640L280-360H120Zm80-80h114l126 126v-332L314-440H200v80Z"/>
        </svg>
      `;
    } else if (vol < 0.5) {
      // Low Volume Icon
      iconBtn.title = 'Отключить звук (Mute)';
      iconBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" height="18px" viewBox="0 -960 960 960" width="18px" fill="currentColor">
          <path d="M200-360v-240h160l200-200v640L360-360H200Zm440 40v-320q45 22 72.5 64.5T740-480q0 53-27.5 95.5T640-320Z"/>
        </svg>
      `;
    } else {
      // High Volume Icon
      iconBtn.title = 'Отключить звук (Mute)';
      iconBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" height="18px" viewBox="0 -960 960 960" width="18px" fill="currentColor">
          <path d="M560-131v-82q90-26 145-100t55-167q0-93-55-167T560-747v-82q124 28 202 125.5T840-480q0 127-78 224.5T560-131ZM120-360v-240h160l200-200v640L280-360H120Zm440 40v-320q45 22 72.5 64.5T660-480q0 53-27.5 95.5T560-320Z"/>
        </svg>
      `;
    }
  }

  toggleShuffle() {
    this.isShuffle = !this.isShuffle;
    const btn = document.getElementById('ctrl-shuffle');
    if (btn) {
      btn.classList.toggle('active', this.isShuffle);
      btn.title = this.isShuffle ? 'Перемешивание: Включено' : 'Перемешивание: Выключено';
    }

    if (this.activeSource === 'local') this.applyLocalShuffle();

    // Sync shuffle state across all services
    this.syncShuffleState();
  }

  syncShuffleState() {
    this.sendWebviewCommand('wv-soundcloud', 'setShuffle', this.isShuffle);
    this.sendWebviewCommand('wv-yandex', 'setShuffle', this.isShuffle);
  }

  toggleRepeat() {
    if (this.repeatMode === 'none') {
      this.repeatMode = 'all';
    } else if (this.repeatMode === 'all') {
      this.repeatMode = 'one';
    } else {
      this.repeatMode = 'none';
    }
    this.updateRepeatUI();
    this.syncRepeatState();
  }

  updateRepeatUI() {
    const btn = document.getElementById('ctrl-repeat');
    if (!btn) return;

    btn.classList.toggle('active', this.repeatMode !== 'none');
    btn.classList.toggle('repeat-one', this.repeatMode === 'one');

    if (this.repeatMode === 'one') {
      btn.title = 'Повтор: Один трек';
    } else if (this.repeatMode === 'all') {
      btn.title = 'Повтор: Все треки';
    } else {
      btn.title = 'Повтор: Выключен';
    }
  }

  syncRepeatState() {
    this.sendWebviewCommand('wv-soundcloud', 'setRepeat', this.repeatMode);
    this.sendWebviewCommand('wv-yandex', 'setRepeat', this.repeatMode);
  }

  formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  updateTrackInfoUI(track) {
    const titleEl = document.getElementById('player-track-title');
    const artistEl = document.getElementById('player-track-artist');
    const artEl = document.getElementById('player-art-img');
    const placeholder = document.getElementById('player-art-placeholder');
    const likeBtn = document.getElementById('player-like-btn');

    if (titleEl) titleEl.textContent = track.title || track.filename;
    if (artistEl) artistEl.textContent = track.artist || 'Неизвестный исполнитель';
    
    if (artEl && placeholder) {
      if (track.coverArt) {
        artEl.src = track.coverArt;
        artEl.style.display = 'block';
        placeholder.style.display = 'none';
      } else {
        artEl.style.display = 'none';
        placeholder.style.display = 'block';
      }
    }

    if (likeBtn) {
      likeBtn.style.display = 'flex';
      likeBtn.classList.toggle('liked', !!track.isLiked);
      likeBtn.title = track.isLiked ? 'Убрать из избранного' : 'В избранное';
      likeBtn.onclick = () => {
        window.api.library.toggleLike(track.id).then(isLiked => {
          track.isLiked = isLiked;
          likeBtn.classList.toggle('liked', isLiked);
          likeBtn.title = isLiked ? 'Убрать из избранного' : 'В избранное';
          if (window.libraryUI) window.libraryUI.refreshLikes();
        });
      };
    }

    const downloadBtn = document.getElementById('player-download-btn');
    if (downloadBtn) {
      downloadBtn.style.display = 'none';
    }

    this.pushOverlayState();
  }

  updateExternalTrackInfoUI(service, data) {
    if (!data) return;
    const titleEl = document.getElementById('player-track-title');
    const artistEl = document.getElementById('player-track-artist');
    const artEl = document.getElementById('player-art-img');
    const placeholder = document.getElementById('player-art-placeholder');
    const likeBtn = document.getElementById('player-like-btn');
    const downloadBtn = document.getElementById('player-download-btn');

    const serviceNames = {
      yandex: 'Яндекс Музыка',
      soundcloud: 'SoundCloud'
    };

    if (titleEl) {
      titleEl.textContent = data.title || serviceNames[service] || 'Аудио';
    }
    if (artistEl) {
      artistEl.textContent = data.artist || (data.title ? '' : 'Воспроизведение...');
    }
    
    if (artEl && placeholder) {
      if (data.cover) {
        artEl.src = data.cover;
        artEl.style.display = 'block';
        placeholder.style.display = 'none';
      } else {
        artEl.style.display = 'none';
        placeholder.style.display = 'block';
      }
    }

    this.updateServiceLikeButton(service);

    if (downloadBtn) {
      downloadBtn.style.display = (service === 'soundcloud') ? 'flex' : 'none';
    }

    this.pushOverlayState();
  }

  // Heart in the player bar for SoundCloud / Yandex: mirrors and presses the site's own like button
  updateServiceLikeButton(service) {
    const likeBtn = document.getElementById('player-like-btn');
    if (!likeBtn) return;
    const liked = this.serviceMetadata[service]?.liked;
    if (liked === null || liked === undefined) {
      likeBtn.style.display = 'none';
      return;
    }
    likeBtn.style.display = 'flex';
    likeBtn.classList.toggle('liked', !!liked);
    likeBtn.title = liked ? 'Убрать из «Мне нравится»' : 'Добавить в «Мне нравится»';
    likeBtn.onclick = async () => {
      if (likeBtn.dataset.busy) return;
      likeBtn.dataset.busy = '1';
      // optimistic flip; the bridge reports the real state right after
      likeBtn.classList.toggle('liked', !liked);
      try {
        const result = await this.callWebview(service, 'toggleLike');
        if (result !== null && result !== undefined) {
          this.serviceMetadata[service].liked = result;
        }
      } finally {
        delete likeBtn.dataset.busy;
        if (this.activeSource === service) this.updateServiceLikeButton(service);
      }
    };
  }

  updateSourceBadge(service) {
    // Artist name links to the artist page only for streaming services
    document.getElementById('player-track-artist')?.classList.toggle('clickable', service !== 'local');

    const badgeEl = document.getElementById('player-source-badge');
    if (!badgeEl) return;

    if (service === 'local') {
      badgeEl.textContent = 'Медиатека';
      badgeEl.className = 'player-source-tag source-local';
    } else if (service === 'soundcloud') {
      badgeEl.textContent = 'SoundCloud';
      badgeEl.className = 'player-source-tag source-soundcloud';
    } else if (service === 'yandex') {
      badgeEl.textContent = 'Яндекс Музыка';
      badgeEl.className = 'player-source-tag source-yandex';
    }
  }

  updatePlayStateUI(isPlaying) {
    const playBtn = document.getElementById('ctrl-play');
    if (playBtn) {
      playBtn.classList.toggle('playing', isPlaying);
      if (isPlaying) {
        playBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" height="22px" viewBox="0 -960 960 960" width="22px" fill="currentColor">
            <path d="M560-200v-560h160v560H560Zm-320 0v-560h160v560H240Z"/>
          </svg>`;
      } else {
        playBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" height="22px" viewBox="0 -960 960 960" width="22px" fill="currentColor">
            <path d="M320-200v-560l440 280-440 280Z"/>
          </svg>`;
      }
    }

    const curTrack = this.queue[this.currentIndex];
    if (curTrack && this.activeSource === 'local') {
      document.querySelectorAll('.track-row').forEach(row => {
        if (row.dataset.id === curTrack.id) {
          row.classList.toggle('paused', !isPlaying);
        }
      });
    }

    // Keep the "now playing" animation in the queue drawer in sync
    const npAnim = document.querySelector('#queue-now-playing-card .queue-np-anim');
    if (npAnim) npAnim.classList.toggle('paused', !isPlaying);

    this.pushOverlayState();
  }

  getDuration() {
    if (this.activeSource === 'local') {
      return (!isNaN(this.audio.duration) && this.audio.duration > 0) ? this.audio.duration : 0;
    }
    const meta = this.serviceMetadata[this.activeSource];
    return (meta && typeof meta.duration === 'number' && meta.duration > 0) ? meta.duration : 0;
  }

  updateDragProgressUI(percentage) {
    const fillEl = document.getElementById('seek-bar-fill');
    const thumbEl = document.getElementById('seek-bar-thumb');
    const curTimeEl = document.getElementById('player-cur-time');
    const dur = this.getDuration();

    if (fillEl) fillEl.style.width = `${percentage}%`;
    if (thumbEl) thumbEl.style.left = `${percentage}%`;
    if (curTimeEl && dur > 0) {
      curTimeEl.textContent = this.formatTime((percentage / 100) * dur);
    }
  }

  updateProgressUI(currentTime, duration, progressPercent) {
    if (this.isDraggingSeek) return;
    const curTimeEl = document.getElementById('player-cur-time');
    const totalTimeEl = document.getElementById('player-total-time');
    const fillEl = document.getElementById('seek-bar-fill');
    const thumbEl = document.getElementById('seek-bar-thumb');

    if (curTimeEl) curTimeEl.textContent = this.formatTime(currentTime);
    if (totalTimeEl) totalTimeEl.textContent = this.formatTime(duration);
    if (fillEl) fillEl.style.width = `${progressPercent}%`;
    if (thumbEl) thumbEl.style.left = `${progressPercent}%`;

    window.dispatchEvent(new CustomEvent('musichub:progress', { detail: { currentTime, duration } }));
  }

  // Click on the track title: open where the track is playing from
  openCurrentSource() {
    if (this.activeSource === 'local') {
      const track = this.queue[this.currentIndex];
      if (!track) return;
      window.appController?.switchTab('library');
      window.libraryUI?.revealTrack(track);
      return;
    }
    const meta = this.serviceMetadata[this.activeSource];
    this.openServicePage(this.activeSource, meta && meta.permalink);
  }

  // Click on the artist name: open the artist page (streaming services only)
  openCurrentArtist() {
    if (this.activeSource === 'local') return;
    const meta = this.serviceMetadata[this.activeSource];
    if (!meta || !meta.artistUrl) return;
    this.openServicePage(this.activeSource, meta.artistUrl);
  }

  openServicePage(service, url) {
    window.appController?.switchTab(service);
    if (!url || !/^https?:\/\//.test(url)) return;
    // Right after switching the tab the webview may still be loading; retry briefly
    let attempts = 0;
    const tryNavigate = () => {
      const wv = document.getElementById(`wv-${service}`);
      if (wv && wv.src && !(wv.isLoading && wv.isLoading())) {
        this.sendWebviewCommand(`wv-${service}`, 'navigateTo', url);
      } else if (attempts++ < 20) {
        setTimeout(tryNavigate, 500);
      }
    };
    tryNavigate();
  }

  highlightCurrentTrackInTable(trackId) {
    const isAudioPlaying = this.isPlaying && !this.audio.paused;
    document.querySelectorAll('.track-row').forEach(row => {
      if (row.dataset.id === trackId && this.activeSource === 'local') {
        row.classList.add('playing');
        row.classList.toggle('paused', !isAudioPlaying);
      } else {
        row.classList.remove('playing', 'paused');
      }
    });
  }

  updateMediaSession() {
    if ('mediaSession' in navigator && this.activeSource === 'local' && this.currentIndex >= 0) {
      const track = this.queue[this.currentIndex];
      if (!track) return;

      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title || track.filename,
        artist: track.artist || 'Неизвестный исполнитель',
        album: track.album || ''
      });

      navigator.mediaSession.setActionHandler('play', () => this.togglePlay());
      navigator.mediaSession.setActionHandler('pause', () => this.togglePlay());
      navigator.mediaSession.setActionHandler('previoustrack', () => this.previous());
      navigator.mediaSession.setActionHandler('nexttrack', () => this.next());
    }
  }

  hasConfiguredMusicFolder() {
    const libraryConfig = window.appController?.config?.library || {};
    return Boolean(
      (libraryConfig.musicFolder && libraryConfig.musicFolder.trim() !== '') ||
      (Array.isArray(libraryConfig.folders) && libraryConfig.folders.some(f => f && f.trim() !== ''))
    );
  }

  promptChooseMusicFolder() {
    window.appController?.showToast('Сначала укажите папку для сохранения музыки в Настройках', 'warning', 5000);
    window.appController?.openSettingsModal('folders');
  }

  async downloadCurrentSoundCloudTrack() {
    if (!this.hasConfiguredMusicFolder()) {
      this.promptChooseMusicFolder();
      return;
    }

    const scData = this.serviceMetadata.soundcloud;
    const downloadBtn = document.getElementById('player-download-btn');
    const topbarBtn = document.getElementById('btn-sc-download');

    const setDownloading = (isDownloading) => {
      if (downloadBtn) {
        downloadBtn.classList.toggle('downloading', isDownloading);
        downloadBtn.title = isDownloading ? 'Скачивание трека...' : 'Скачать трек в медиатеку';
      }
      if (topbarBtn) {
        topbarBtn.classList.toggle('downloading', isDownloading);
        const span = topbarBtn.querySelector('span');
        if (span) span.textContent = isDownloading ? 'Скачивание...' : 'Скачать трек';
      }
    };

    try {
      setDownloading(true);

      let trackInfo = { ...scData };
      const wv = document.getElementById('wv-soundcloud');
      if (wv) {
        try {
          const bridgeTrack = await wv.executeJavaScript(`window.musicHubBridge ? window.musicHubBridge.getCurrentTrack() : null`);
          if (bridgeTrack) {
            trackInfo = { ...trackInfo, ...bridgeTrack };
          }
        } catch(e) {}
      }

      if (!trackInfo.permalink && !trackInfo.title) {
        window.appController?.showToast('Включите трек в SoundCloud перед скачиванием', 'warning');
        return;
      }

      const isAlbum = (trackInfo.permalink || '').includes('/sets/');
      const startMsg = isAlbum ? `Начато скачивание альбома «${trackInfo.title || 'SoundCloud'}»...` : `Начато скачивание «${trackInfo.title || 'трека'}»...`;
      this.currentDownloadToast = window.appController?.showToast(startMsg, 'loading', 0);

      const res = await window.api.soundcloud.downloadTrack(trackInfo);
      if (this.currentDownloadToast) {
        this.currentDownloadToast.close();
        this.currentDownloadToast = null;
      }

      if (res && res.success) {
        if (res.isAlbum) {
          window.appController?.showToast(`Альбом «${res.artist} - ${res.albumTitle}» (${res.tracksCount} треков) сохранён в раздел Альбомы!`, 'success', 5000);
          if (window.libraryUI) {
            await window.libraryUI.refreshAllData();
          }
        } else {
          window.appController?.showToast(`Трек «${res.track.artist} - ${res.track.title}» успешно сохранён в медиатеку!`, 'success');
          if (window.libraryUI) {
            await window.libraryUI.loadTracks();
          }
        }
      }
    } catch (err) {
      if (this.currentDownloadToast) {
        this.currentDownloadToast.close();
        this.currentDownloadToast = null;
      }
      console.error('Download SoundCloud track error:', err);
      window.appController?.showToast(`Ошибка скачивания: ${err.message || 'Не удалось скачать трек'}`, 'error');
    } finally {
      setDownloading(false);
    }
  }

  async downloadSoundCloudTrackByUrl(url, title = '') {
    if (!this.hasConfiguredMusicFolder()) {
      this.promptChooseMusicFolder();
      return;
    }

    let downloadToast = null;
    try {
      const isAlbum = url.includes('/sets/');
      const startMsg = isAlbum ? `Начато скачивание альбома «${title || 'SoundCloud'}»...` : `Начато скачивание «${title || 'трека'}»...`;
      downloadToast = window.appController?.showToast(startMsg, 'loading', 0);
      this.currentDownloadToast = downloadToast;

      const res = await window.api.soundcloud.downloadByUrl(url);
      if (downloadToast) {
        downloadToast.close();
        if (this.currentDownloadToast === downloadToast) {
          this.currentDownloadToast = null;
        }
      }

      if (res && res.success) {
        if (res.isAlbum) {
          window.appController?.showToast(`Альбом «${res.artist} - ${res.albumTitle}» (${res.tracksCount} треков) сохранён в раздел Альбомы!`, 'success', 5000);
          if (window.libraryUI) {
            await window.libraryUI.refreshAllData();
          }
        } else {
          window.appController?.showToast(`Трек «${res.track.artist} - ${res.track.title}» добавлен в медиатеку!`, 'success');
          if (window.libraryUI) {
            await window.libraryUI.loadTracks();
          }
        }
      }
    } catch (err) {
      if (downloadToast) {
        downloadToast.close();
        if (this.currentDownloadToast === downloadToast) {
          this.currentDownloadToast = null;
        }
      }
      console.error('Download SoundCloud track error:', err);
      window.appController?.showToast(`Ошибка скачивания: ${err.message || 'Не удалось скачать трек'}`, 'error');
    }
  }
}

window.localPlayer = new UniversalPlayerManager();
