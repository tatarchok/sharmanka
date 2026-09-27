/* ==========================================================================
   Fullscreen "Now Playing" view: large artwork, player controls and lyrics.
   Opened by clicking the artwork in the bottom player bar. It mirrors the
   bottom bar's state (track info, play/shuffle/repeat buttons) and delegates
   every action to window.localPlayer, so all sources work the same way.
   ========================================================================== */

class NowPlayingView {
  constructor() {
    this.isOpen = false;
    this.lyrics = null;          // { synced: [{time,text}], plain } | null
    this.lyricsKey = '';         // artist|title the current lyrics belong to
    this.lyricsRequestId = 0;
    this.activeLineIndex = -1;
    this.currentTime = 0;
    this.duration = 0;
    this.isDraggingSeek = false;
    this.userScrolledAt = 0;

    this.build();
    this.bindPlayerBar();
    this.bindControls();
    this.bindVolume();
    this.observePlayerBar();
    this.observeAppBackground();
    this.syncFromPlayerBar();
  }

  // Volume slider mirrors the bottom bar's slider both ways
  bindVolume() {
    const slider = this.el('np-vol-slider');
    const saveVolume = (val) => {
      const app = window.appController;
      if (app && app.config) {
        app.config.volume = val;
        window.api.library.saveConfig(app.config).catch(() => {});
      }
    };

    slider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      window.localPlayer?.setVolume(val);
      saveVolume(val);
    });

    this.el('np-volume').addEventListener('wheel', (e) => {
      e.preventDefault();
      const cur = window.localPlayer?.audio?.volume ?? parseFloat(slider.value);
      const delta = (e.deltaY < 0 || e.deltaX > 0) ? 0.05 : -0.05;
      const next = Math.max(0, Math.min(1, Math.round((cur + delta) * 100) / 100));
      window.localPlayer?.setVolume(next);
      saveVolume(next);
    }, { passive: false });

    // toggleMute saves the config itself
    this.el('np-vol-btn').addEventListener('click', () => window.localPlayer?.toggleMute());

    window.addEventListener('musichub:volume', (e) => this.renderVolume(e.detail?.volume));
    this.renderVolume(window.localPlayer?.audio?.volume ?? 0.8);
  }

  renderVolume(vol) {
    if (typeof vol !== 'number' || isNaN(vol)) return;
    const slider = this.el('np-vol-slider');
    if (document.activeElement !== slider || Math.abs(parseFloat(slider.value) - vol) > 0.001) slider.value = vol;
    slider.style.setProperty('--vol-percent', `${(vol * 100).toFixed(1)}%`);

    const btn = this.el('np-vol-btn');
    btn.title = vol === 0 ? 'Включить звук' : 'Отключить звук';
    const path = vol === 0
      ? 'm664-328-56-56 80-80-80-80 56-56 80 80 80-80 56 56-80 80 80 80-56 56-80-80-80 80ZM120-360v-240h160l200-200v640L280-360H120Zm80-80h114l126 126v-332L314-440H200v80Z'
      : vol < 0.5
        ? 'M200-360v-240h160l200-200v640L360-360H200Zm440 40v-320q45 22 72.5 64.5T740-480q0 53-27.5 95.5T640-320Z'
        : 'M560-131v-82q90-26 145-100t55-167q0-93-55-167T560-747v-82q124 28 202 125.5T840-480q0 127-78 224.5T560-131ZM120-360v-240h160l200-200v640L280-360H120Zm440 40v-320q45 22 72.5 64.5T660-480q0 53-27.5 95.5T560-320Z';
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 -960 960 960" width="20px" fill="currentColor"><path d="${path}"/></svg>`;
  }

  // Use the user's app background (Settings → Appearance) with the same blur/dim settings
  observeAppBackground() {
    const source = document.getElementById('app-bg-image');
    const sync = () => {
      const image = source ? source.style.backgroundImage : '';
      const hasImage = !!(image && image !== 'none');
      this.el('np-app-bg-image').style.backgroundImage = hasImage ? image : 'none';
      this.root.classList.toggle('has-app-bg', hasImage);
    };
    if (source) new MutationObserver(sync).observe(source, { attributes: true, attributeFilter: ['style', 'class'] });
    sync();
  }

  build() {
    const root = document.createElement('div');
    root.className = 'np-view';
    root.id = 'np-view';
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = `
      <div class="np-backdrop" id="np-backdrop"></div>
      <div class="np-app-bg" id="np-app-bg">
        <div class="np-app-bg-image" id="np-app-bg-image"></div>
        <div class="np-app-bg-dim"></div>
      </div>
      <button class="np-close-btn" id="np-close" title="Свернуть (Esc)">
        <svg xmlns="http://www.w3.org/2000/svg" height="26px" viewBox="0 -960 960 960" width="26px" fill="currentColor">
          <path d="M480-344 240-584l56-56 184 184 184-184 56 56-240 240Z"/>
        </svg>
      </button>

      <div class="np-layout">
        <div class="np-main">
          <div class="np-artwork">
            <img id="np-art-img" alt="" />
            <svg id="np-art-placeholder" xmlns="http://www.w3.org/2000/svg" height="96px" viewBox="0 -960 960 960" width="96px" fill="currentColor">
              <path d="M400-120q-66 0-113-47t-47-113q0-66 47-113t113-47q23 0 42.5 5.5T480-418v-422h240v160H560v400q0 66-47 113t-113 47Z"/>
            </svg>
          </div>

          <div class="np-info">
            <span class="np-source-tag" id="np-source-badge"></span>
            <div class="np-title" id="np-title" title="Открыть источник"></div>
            <div class="np-artist" id="np-artist"></div>
          </div>

          <div class="np-progress">
            <div class="np-seek" id="np-seek">
              <div class="np-seek-track"><div class="np-seek-fill" id="np-seek-fill"></div></div>
              <div class="np-seek-thumb" id="np-seek-thumb"></div>
            </div>
            <div class="np-times">
              <span id="np-cur-time">0:00</span>
              <span id="np-total-time">0:00</span>
            </div>
          </div>

          <div class="np-controls">
            <button class="np-ctrl" id="np-shuffle" title="Перемешать">
              <svg xmlns="http://www.w3.org/2000/svg" height="22px" viewBox="0 -960 960 960" width="22px" fill="currentColor">
                <path d="M560-160v-80h104L537-367l57-57 126 124v-100h80v240H560Zm0-480v-80h240v240h-80v-104L594-458l-57-56 127-126H560ZM160-160l424-424 56 56-424 424h-56Zm0-480h56l184 184-56 56-184-184v-56Z"/>
              </svg>
            </button>
            <button class="np-ctrl" id="np-prev" title="Предыдущий трек">
              <svg xmlns="http://www.w3.org/2000/svg" height="30px" viewBox="0 -960 960 960" width="30px" fill="currentColor">
                <path d="M220-240v-480h80v480h-80Zm520 0L380-480l360-240v480Z"/>
              </svg>
            </button>
            <button class="np-ctrl np-ctrl-play" id="np-play" title="Воспроизведение"></button>
            <button class="np-ctrl" id="np-next" title="Следующий трек">
              <svg xmlns="http://www.w3.org/2000/svg" height="30px" viewBox="0 -960 960 960" width="30px" fill="currentColor">
                <path d="M660-240v-480h80v480h-80ZM220-240v-480l360 240-360 240Z"/>
              </svg>
            </button>
            <button class="np-ctrl" id="np-repeat" title="Повтор">
              <svg xmlns="http://www.w3.org/2000/svg" height="22px" viewBox="0 -960 960 960" width="22px" fill="currentColor">
                <path d="M280-160v-80h400q50 0 85-35t35-85v-200h-80v200q0 17-11.5 28.5T680-320H280v-80L160-280l120 120Zm400-480v80H280q-50 0-85 35t-35 85v200h80v-200q0-17 11.5-28.5T280-640h400v80l120-120-120-120Z"/>
              </svg>
            </button>
          </div>

          <div class="np-volume" id="np-volume">
            <button class="np-vol-btn" id="np-vol-btn" title="Отключить звук"></button>
            <input class="vol-slider np-vol-slider" id="np-vol-slider" type="range" min="0" max="1" step="0.01" value="0.8" />
          </div>
        </div>

        <div class="np-lyrics-panel">
          <div class="np-lyrics-header">
            <span>Текст песни</span>
            <span class="np-lyrics-source" id="np-lyrics-source"></span>
          </div>
          <div class="np-lyrics" id="np-lyrics"></div>
        </div>
      </div>
    `;
    document.body.appendChild(root);

    this.root = root;
    this.el = (id) => document.getElementById(id);
  }

  bindPlayerBar() {
    const artWrap = document.getElementById('player-art-wrap');
    if (artWrap) {
      artWrap.classList.add('clickable');
      artWrap.title = 'Открыть на весь экран';
      artWrap.addEventListener('click', () => this.open());
    }
  }

  bindControls() {
    const player = () => window.localPlayer;

    this.el('np-close').addEventListener('click', () => this.close());
    this.el('np-play').addEventListener('click', () => player()?.togglePlay());
    this.el('np-prev').addEventListener('click', () => player()?.previous());
    this.el('np-next').addEventListener('click', () => player()?.next());
    this.el('np-shuffle').addEventListener('click', () => player()?.toggleShuffle());
    this.el('np-repeat').addEventListener('click', () => player()?.toggleRepeat());

    this.el('np-title').addEventListener('click', () => {
      this.close();
      player()?.openCurrentSource();
    });
    this.el('np-artist').addEventListener('click', () => {
      if (!this.el('np-artist').classList.contains('clickable')) return;
      this.close();
      player()?.openCurrentArtist();
    });

    document.addEventListener('keydown', (e) => {
      if (this.isOpen && e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });

    // Seek bar (click + drag)
    const seek = this.el('np-seek');
    const pctFromEvent = (e) => {
      const rect = seek.getBoundingClientRect();
      return Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    };
    seek.addEventListener('pointerdown', (e) => {
      this.isDraggingSeek = true;
      seek.setPointerCapture(e.pointerId);
      this.renderProgress((pctFromEvent(e) / 100) * this.duration, this.duration);
    });
    seek.addEventListener('pointermove', (e) => {
      if (this.isDraggingSeek) this.renderProgress((pctFromEvent(e) / 100) * this.duration, this.duration);
    });
    seek.addEventListener('pointerup', (e) => {
      if (!this.isDraggingSeek) return;
      this.isDraggingSeek = false;
      player()?.seek(pctFromEvent(e));
    });

    // Progress coming from the active source
    window.addEventListener('musichub:progress', (e) => {
      const { currentTime, duration } = e.detail || {};
      this.currentTime = Number(currentTime) || 0;
      this.duration = Number(duration) || 0;
      if (!this.isDraggingSeek) this.renderProgress(this.currentTime, this.duration);
      if (this.isOpen) this.updateActiveLyricLine();
    });

    // Pause lyrics auto-scroll briefly while the user scrolls manually
    this.el('np-lyrics').addEventListener('wheel', () => { this.userScrolledAt = Date.now(); }, { passive: true });
  }

  // Mirror every change of the bottom player bar
  observePlayerBar() {
    const targets = ['player-track-title', 'player-track-artist', 'player-art-img', 'player-source-badge', 'ctrl-play', 'ctrl-shuffle', 'ctrl-repeat']
      .map(id => document.getElementById(id))
      .filter(Boolean);
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        this.syncFromPlayerBar();
      });
    });
    targets.forEach(t => observer.observe(t, { attributes: true, childList: true, characterData: true, subtree: true }));
  }

  syncFromPlayerBar() {
    const title = document.getElementById('player-track-title')?.textContent || '';
    const artistEl = document.getElementById('player-track-artist');
    const artist = artistEl?.textContent || '';
    const artImg = document.getElementById('player-art-img');
    const hasArt = !!(artImg && artImg.style.display !== 'none' && artImg.getAttribute('src'));
    const badge = document.getElementById('player-source-badge');

    this.el('np-title').textContent = title;
    this.el('np-artist').textContent = artist;
    this.el('np-artist').classList.toggle('clickable', !!artistEl?.classList.contains('clickable'));

    const npImg = this.el('np-art-img');
    if (hasArt) {
      const hiRes = this.highResCover(artImg.src);
      if (npImg.dataset.original !== artImg.src) {
        npImg.dataset.original = artImg.src;
        // Fall back to the original artwork if the large version doesn't exist
        npImg.onerror = () => {
          npImg.onerror = null;
          npImg.src = artImg.src;
          this.el('np-backdrop').style.backgroundImage = `url("${artImg.src}")`;
        };
        npImg.src = hiRes;
      }
      npImg.style.display = 'block';
      this.el('np-art-placeholder').style.display = 'none';
      this.el('np-backdrop').style.backgroundImage = `url("${npImg.src}")`;
    } else {
      npImg.removeAttribute('src');
      delete npImg.dataset.original;
      npImg.style.display = 'none';
      this.el('np-art-placeholder').style.display = 'block';
      this.el('np-backdrop').style.backgroundImage = 'none';
    }

    if (badge) {
      const npBadge = this.el('np-source-badge');
      npBadge.textContent = badge.textContent;
      npBadge.className = 'np-source-tag ' + Array.from(badge.classList).filter(c => c.startsWith('source-')).join(' ');
    }

    // Controls state
    const playBtn = document.getElementById('ctrl-play');
    const isPlaying = !!playBtn?.classList.contains('playing');
    this.el('np-play').innerHTML = isPlaying
      ? `<svg xmlns="http://www.w3.org/2000/svg" height="34px" viewBox="0 -960 960 960" width="34px" fill="currentColor"><path d="M560-200v-560h160v560H560Zm-320 0v-560h160v560H240Z"/></svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" height="34px" viewBox="0 -960 960 960" width="34px" fill="currentColor"><path d="M320-200v-560l440 280-440 280Z"/></svg>`;
    this.el('np-play').title = isPlaying ? 'Пауза' : 'Воспроизведение';

    const shuffleBtn = document.getElementById('ctrl-shuffle');
    this.el('np-shuffle').classList.toggle('active', !!shuffleBtn?.classList.contains('active'));
    const repeatBtn = document.getElementById('ctrl-repeat');
    this.el('np-repeat').classList.toggle('active', !!repeatBtn?.classList.contains('active'));
    this.el('np-repeat').classList.toggle('repeat-one', !!repeatBtn?.classList.contains('repeat-one'));
    this.el('np-repeat').title = repeatBtn?.title || 'Повтор';

    if (this.isOpen) this.loadLyricsIfNeeded();
  }

  // SoundCloud badge artwork is tiny (t50x50/t80x80); request the large version
  highResCover(src) {
    if (!src) return src;
    return src.replace(/-(t\d+x\d+|large|small|badge|tiny)\.(jpg|png|webp)/i, '-t500x500.$2');
  }

  open() {
    const title = document.getElementById('player-track-title')?.textContent || '';
    const hasTrack = window.localPlayer && (window.localPlayer.activeSource !== 'local' || window.localPlayer.currentIndex >= 0);
    if (!hasTrack || !title) return;

    this.isOpen = true;
    document.body.classList.add('np-open');
    this.root.classList.add('open');
    this.root.setAttribute('aria-hidden', 'false');
    this.syncFromPlayerBar();
    this.renderProgress(this.currentTime, this.duration || window.localPlayer?.getDuration?.() || 0);
    this.loadLyricsIfNeeded();
    this.activeLineIndex = -1;
    this.updateActiveLyricLine(true);
  }

  close() {
    this.isOpen = false;
    document.body.classList.remove('np-open');
    this.root.classList.remove('open');
    this.root.setAttribute('aria-hidden', 'true');
  }

  renderProgress(currentTime, duration) {
    const pct = duration > 0 ? Math.max(0, Math.min(100, (currentTime / duration) * 100)) : 0;
    this.el('np-seek-fill').style.width = `${pct}%`;
    this.el('np-seek-thumb').style.left = `${pct}%`;
    this.el('np-cur-time').textContent = this.formatTime(currentTime);
    this.el('np-total-time').textContent = this.formatTime(duration);
  }

  formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  // ---------------------------------------------------------------------
  // Lyrics
  // ---------------------------------------------------------------------
  getCurrentTrackQuery() {
    const player = window.localPlayer;
    let title = '';
    let artist = '';
    if (player?.activeSource === 'local') {
      const t = player.queue[player.currentIndex];
      if (t) {
        title = t.title || (t.filename || '').replace(/\.[^.]+$/, '');
        artist = t.artist && t.artist !== 'Неизвестный исполнитель' ? t.artist : '';
      }
    } else if (player) {
      const meta = player.serviceMetadata[player.activeSource] || {};
      title = meta.title || '';
      artist = meta.artist || '';
    }
    return { title, artist, duration: player?.getDuration?.() || 0 };
  }

  async loadLyricsIfNeeded() {
    const query = this.getCurrentTrackQuery();
    if (!query.title) {
      this.lyricsKey = '';
      this.renderLyricsMessage('Нет информации о треке');
      return;
    }
    const key = `${query.artist.toLowerCase()}|${query.title.toLowerCase()}`;
    if (key === this.lyricsKey) return;

    this.lyricsKey = key;
    this.lyrics = null;
    this.activeLineIndex = -1;
    const requestId = ++this.lyricsRequestId;
    this.renderLyricsMessage('Ищем текст песни…', true);

    let result = null;
    try {
      result = await window.api.lyrics.get(query);
    } catch (e) {
      result = { found: false, error: e.message };
    }
    if (requestId !== this.lyricsRequestId) return; // track changed meanwhile

    if (!result || !result.found) {
      this.lyricsKey = result && result.error ? '' : key; // allow retry after network errors
      this.renderLyricsMessage(result && result.error
        ? 'Не удалось загрузить текст. Проверьте подключение к интернету.'
        : 'Текст для этого трека не найден');
      return;
    }

    this.lyrics = result;
    this.el('np-lyrics-source').textContent = result.synced.length ? `${result.source} · синхронизировано` : result.source;
    this.renderLyrics();
  }

  renderLyricsMessage(text, loading = false) {
    this.el('np-lyrics-source').textContent = '';
    const container = this.el('np-lyrics');
    container.classList.remove('synced');
    container.innerHTML = '';
    const msg = document.createElement('div');
    msg.className = 'np-lyrics-message' + (loading ? ' loading' : '');
    msg.textContent = text;
    container.appendChild(msg);
  }

  renderLyrics() {
    const container = this.el('np-lyrics');
    container.innerHTML = '';
    container.scrollTop = 0;
    const { synced, plain } = this.lyrics;

    if (synced && synced.length) {
      container.classList.add('synced');
      synced.forEach((line, idx) => {
        const div = document.createElement('div');
        div.className = 'np-lyric-line';
        div.textContent = line.text || '♪';
        div.dataset.index = idx;
        div.title = this.formatTime(line.time);
        div.addEventListener('click', () => {
          const dur = this.duration || window.localPlayer?.getDuration?.() || 0;
          if (dur > 0) window.localPlayer?.seek((line.time / dur) * 100);
        });
        container.appendChild(div);
      });
      this.updateActiveLyricLine(true);
    } else {
      container.classList.remove('synced');
      plain.split(/\r?\n/).forEach(text => {
        const div = document.createElement('div');
        div.className = 'np-lyric-line plain';
        div.textContent = text || ' ';
        container.appendChild(div);
      });
    }
  }

  updateActiveLyricLine(force = false) {
    const synced = this.lyrics && this.lyrics.synced;
    if (!synced || !synced.length) return;

    // Small lead so the line lights up as it is sung, not after
    const t = this.currentTime + 0.3;
    let idx = -1;
    for (let i = 0; i < synced.length; i++) {
      if (synced[i].time <= t) idx = i; else break;
    }
    if (idx === this.activeLineIndex && !force) return;
    this.activeLineIndex = idx;

    const container = this.el('np-lyrics');
    container.querySelectorAll('.np-lyric-line').forEach(el => {
      const i = Number(el.dataset.index);
      el.classList.toggle('active', i === idx);
      el.classList.toggle('past', i < idx);
    });

    const activeEl = idx >= 0 ? container.querySelector(`.np-lyric-line[data-index="${idx}"]`) : null;
    if (activeEl && Date.now() - this.userScrolledAt > 3000) {
      const target = activeEl.offsetTop - container.clientHeight / 2 + activeEl.clientHeight / 2;
      container.scrollTo({ top: Math.max(0, target), behavior: force ? 'auto' : 'smooth' });
    }
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => {
    window.nowPlayingView = new NowPlayingView();
  });
} else {
  window.nowPlayingView = new NowPlayingView();
}
