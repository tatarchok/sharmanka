// Yandex Music Bridge for Music Hub (Universal Hybrid: MediaSession + DOM Layout + externalAPI + Keyboard)
(function() {
  if (window._musicHubBridgeLoaded) return;
  window._musicHubBridgeLoaded = true;

  function emit(event, data) {
    console.log('MUSICHUB_BRIDGE|' + JSON.stringify({
      service: 'yandex',
      event,
      data
    }));
  }

  let activeAudioEl = null;
  let lastTitle = '';
  let lastState = false;
  let lastRepeatMode = '';
  let lastShuffleState = null;

  // Intercept navigator.mediaSession.setActionHandler immediately
  const mediaSessionHandlers = {};
  if (navigator.mediaSession && typeof navigator.mediaSession.setActionHandler === 'function') {
    const origSetActionHandler = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
    navigator.mediaSession.setActionHandler = function(action, handler) {
      if (handler) {
        mediaSessionHandlers[action] = handler;
      } else {
        delete mediaSessionHandlers[action];
      }
      return origSetActionHandler(action, handler);
    };
  }

  function triggerClick(el) {
    if (!el) return false;
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      el.click();
      return true;
    } catch (e) {
      try { el.click(); return true; } catch (err) {}
    }
    return false;
  }

  function parseTime(timeStr) {
    if (!timeStr) return 0;
    const parts = timeStr.trim().split(':').map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
  }

  // Equalizer Support (10-Band Universal AudioContext + MediaElement Graph)
  const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  let eqAudioCtx = null;
  let eqConnectedElements = new WeakSet();
  let eqConfig = { enabled: true, gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
  const contextChains = new WeakMap();
  const allActiveChains = [];

  const rawAudioNodeConnect = AudioNode.prototype.connect;

  function createEqChainForContext(ctx) {
    if (!ctx) return null;
    if (contextChains.has(ctx)) return contextChains.get(ctx);

    try {
      const filters = EQ_FREQS.map((freq, idx) => {
        const filter = ctx.createBiquadFilter();
        if (idx === 0) {
          filter.type = 'lowshelf';
        } else if (idx === EQ_FREQS.length - 1) {
          filter.type = 'highshelf';
        } else {
          filter.type = 'peaking';
          filter.Q.value = 1.4;
        }
        filter.frequency.value = freq;
        filter.gain.value = eqConfig.enabled ? (Number(eqConfig.gains[idx]) || 0) : 0;
        return filter;
      });

      for (let i = 0; i < filters.length - 1; i++) {
        rawAudioNodeConnect.call(filters[i], filters[i + 1]);
      }
      rawAudioNodeConnect.call(filters[filters.length - 1], ctx.destination);

      const chain = {
        ctx,
        firstFilter: filters[0],
        lastFilter: filters[filters.length - 1],
        filters: filters
      };
      contextChains.set(ctx, chain);
      allActiveChains.push(chain);
      return chain;
    } catch (e) {
      console.warn('[Yandex Bridge EQ] Error creating context EQ chain:', e);
      return null;
    }
  }

  // Intercept AudioNode.prototype.connect safely for any node routing to destination
  AudioNode.prototype.connect = function(destination, outputIndex, inputIndex) {
    try {
      if (destination && this.context && (destination === this.context.destination || (window.AudioDestinationNode && destination instanceof window.AudioDestinationNode))) {
        const chain = createEqChainForContext(this.context);
        if (chain && this !== chain.lastFilter && !chain.filters.includes(this)) {
          return rawAudioNodeConnect.call(this, chain.firstFilter, outputIndex, inputIndex);
        }
      }
    } catch (e) {}
    return rawAudioNodeConnect.apply(this, arguments);
  };

  function initEq() {
    if (eqAudioCtx) return;
    try {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtxClass) return;
      eqAudioCtx = new AudioCtxClass();
      createEqChainForContext(eqAudioCtx);
    } catch (e) {
      console.warn('[Yandex Bridge EQ] Init error:', e);
    }
  }

  function connectAudioToEq(audio) {
    if (!audio) return;
    if (eqConnectedElements.has(audio)) return;

    try {
      initEq();
      if (!eqAudioCtx) return;
      const chain = createEqChainForContext(eqAudioCtx);
      if (!chain) return;
      const sourceNode = eqAudioCtx.createMediaElementSource(audio);
      rawAudioNodeConnect.call(sourceNode, chain.firstFilter);
      eqConnectedElements.add(audio);
      if (eqAudioCtx.state === 'suspended') {
        eqAudioCtx.resume().catch(() => {});
      }
    } catch (e) {
      // Element might already be connected
    }
  }

  function applyEqGains() {
    allActiveChains.forEach(chain => {
      if (!chain || !chain.filters) return;
      chain.filters.forEach((filter, idx) => {
        try {
          const val = eqConfig.enabled ? (Number(eqConfig.gains[idx]) || 0) : 0;
          filter.gain.value = val;
        } catch(e) {}
      });
      if (chain.ctx && chain.ctx.state === 'suspended') {
        chain.ctx.resume().catch(() => {});
      }
    });
  }

  function registerAudio(audio) {
    if (!audio) return;

    if (typeof window._currentVolume === 'number') {
      try { audio.volume = window._currentVolume; } catch (e) {}
    }

    connectAudioToEq(audio);

    if (!audio._mhTracked) {
      audio._mhTracked = true;
      activeAudioEl = audio;

      if (window._repeatMode === 'one') {
        audio.loop = true;
      }

      audio.addEventListener('play', () => {
        activeAudioEl = audio;
        lastState = true;
        if (typeof window._currentVolume === 'number') {
          try { audio.volume = window._currentVolume; } catch (e) {}
        }
        if (eqAudioCtx && eqAudioCtx.state === 'suspended') {
          eqAudioCtx.resume().catch(() => {});
        }
        connectAudioToEq(audio);
        emit('state', { isPlaying: true });
        extractAndEmitTrack();
      });

      audio.addEventListener('pause', () => {
        lastState = false;
        emit('state', { isPlaying: false });
      });

      audio.addEventListener('ended', () => {
        if (window._repeatMode === 'one' || audio.loop) {
          audio.currentTime = 0;
          audio.play().catch(() => {});
        }
      });

      audio.addEventListener('timeupdate', () => {
        if (audio.duration && !isNaN(audio.duration) && audio.duration > 0) {
          emit('progress', {
            position: Math.round(audio.currentTime),
            duration: Math.round(audio.duration)
          });
        }
      });
    }

    if (!audio.paused && audio.currentTime > 0) {
      activeAudioEl = audio;
    }
  }

  // Intercept window.Audio
  const origAudio = window.Audio;
  if (origAudio) {
    window.Audio = function() {
      const a = new origAudio(...arguments);
      try { a.crossOrigin = 'anonymous'; } catch(e) {}
      registerAudio(a);
      return a;
    };
    window.Audio.prototype = origAudio.prototype;
  }

  // Intercept document.createElement
  const origCreateElement = document.createElement;
  document.createElement = function(tagName) {
    const el = origCreateElement.apply(this, arguments);
    if (el && typeof tagName === 'string') {
      const tag = tagName.toLowerCase();
      if (tag === 'audio' || tag === 'video') {
        try { el.crossOrigin = 'anonymous'; } catch(e) {}
        registerAudio(el);
      }
    }
    return el;
  };

  // Intercept HTMLMediaElement.prototype.play
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function() {
    try {
      if (!this.crossOrigin) this.crossOrigin = 'anonymous';
      if (typeof window._currentVolume === 'number') {
        this.volume = window._currentVolume;
      }
      registerAudio(this);
      if (eqAudioCtx && eqAudioCtx.state === 'suspended') {
        eqAudioCtx.resume().catch(() => {});
      }
    } catch (e) {}
    return origPlay.apply(this, arguments);
  };

  // User gesture listener to unblock AudioContext immediately
  ['click', 'keydown', 'mousedown', 'pointerdown', 'touchstart'].forEach(evt => {
    window.addEventListener(evt, () => {
      if (eqAudioCtx && eqAudioCtx.state === 'suspended') {
        eqAudioCtx.resume().catch(() => {});
      }
    }, { passive: true, capture: true });
  });

  // Observe DOM for audio elements
  function scanAudios() {
    document.querySelectorAll('audio, video').forEach(registerAudio);
  }
  scanAudios();
  const observer = new MutationObserver(scanAudios);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Hook externalAPI if present
  function hookExternalApi() {
    if (!window.externalAPI) return false;
    const api = window.externalAPI;

    try {
      api.on(api.EVENT_TRACK, function() {
        extractAndEmitTrack();
      });

      api.on(api.EVENT_STATE, function() {
        const isPlaying = api.isPlaying();
        if (isPlaying !== lastState) {
          lastState = isPlaying;
          emit('state', { isPlaying });
        }
      });

      api.on(api.EVENT_PROGRESS, function(progress) {
        if (progress && typeof progress.position === 'number') {
          emit('progress', {
            position: Math.round(progress.position),
            duration: Math.round(progress.duration || (activeAudioEl?.duration || 0))
          });
        }
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  function findCurrentTrackMeta() {
    let trackId = null;
    let albumId = null;
    let title = '';
    let artist = '';
    let album = '';
    let cover = null;
    let duration = 0;
    let permalink = '';
    let artistId = null;

    // 1. Check window.externalAPI
    if (window.externalAPI && typeof window.externalAPI.getCurrentTrack === 'function') {
      try {
        const t = window.externalAPI.getCurrentTrack();
        if (t) {
          title = t.title || '';
          artist = (t.artists && t.artists.map(a => a.name).join(', ')) || '';
          if (t.artists && t.artists[0]) {
            artistId = t.artists[0].id || (t.artists[0].link && (t.artists[0].link.match(/artist\/(\d+)/) || [])[1]) || null;
          }
          album = (t.album && t.album.title) || (t.albums && t.albums[0] && t.albums[0].title) || '';
          if (t.cover) cover = 'https://' + t.cover.replace('%%', '600x600');
          duration = Math.round(t.duration || 0);
          trackId = t.id || null;
          if (t.album && t.album.id) albumId = t.album.id;
          else if (t.albums && t.albums[0] && t.albums[0].id) albumId = t.albums[0].id;
          if (t.link) permalink = t.link.startsWith('http') ? t.link : `https://music.yandex.ru${t.link}`;
        }
      } catch (e) {}
    }

    // 2. Check React Fiber on player bar elements
    if (!trackId || !title) {
      try {
        const barEls = document.querySelectorAll('[data-test-id="PlayerBar"], [class*="PlayerBar"], [class*="player-bar"], .bar, [data-test-id="TRACK_TITLE"]');
        for (const el of barEls) {
          const fKey = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
          if (fKey) {
            let f = el[fKey];
            let depth = 0;
            while (f && depth < 25) {
              const p = f.memoizedProps;
              if (p) {
                const cand = p.track || p.currentTrack || p.item || (p.trackId ? p : null);
                if (cand && (cand.id || cand.trackId || cand.title)) {
                  if (!trackId) trackId = cand.id || cand.trackId;
                  if (!albumId) albumId = cand.albumId || (cand.albums && cand.albums[0] && cand.albums[0].id) || (cand.album && cand.album.id);
                  if (!title) title = cand.title;
                  if (!artist && cand.artists) artist = cand.artists.map(a => a.name || a).join(', ');
                  if (!artistId && cand.artists && cand.artists[0] && cand.artists[0].id) artistId = cand.artists[0].id;
                  if (!cover && (cand.cover || cand.coverUri)) {
                    cover = 'https://' + (cand.cover || cand.coverUri).replace('%%', '600x600');
                  }
                  break;
                }
              }
              f = f.return;
              depth++;
            }
          }
          if (trackId && title) break;
        }
      } catch(e) {}
    }

    // 3. Check active playing row in track list
    if (!trackId) {
      const playingRow = document.querySelector('.d-track_playing, [class*="Track_playing"], [class*="TrackItem_playing"], [aria-current="true"]');
      if (playingRow) {
        trackId = playingRow.getAttribute('data-id') || playingRow.getAttribute('data-track-id');
        const link = playingRow.querySelector('a[href*="/track/"]');
        if (link) {
          const m = (link.getAttribute('href') || link.href || '').match(/track\/(\d+)/);
          if (m) trackId = m[1];
        }
      }
    }

    // 4. Check player bar links
    if (!trackId || !albumId) {
      const links = document.querySelectorAll('[class*="PlayerBar"] a, .bar a, [data-test-id="PlayerBar"] a, a[href*="/track/"]');
      for (const link of links) {
        const href = link.getAttribute('href') || link.href || '';
        const mBoth = href.match(/album\/(\d+)\/track\/(\d+)/);
        if (mBoth) {
          if (!albumId) albumId = mBoth[1];
          if (!trackId) trackId = mBoth[2];
          break;
        }
        const mTr = href.match(/track\/(\d+)/);
        if (mTr && !trackId) trackId = mTr[1];
        const mAl = href.match(/album\/(\d+)/);
        if (mAl && !albumId) albumId = mAl[1];
      }
    }

    // Artist link in the player bar
    if (!artistId) {
      const artistLink = document.querySelector('[class*="PlayerBar"] a[href*="/artist/"], [data-test-id="PlayerBar"] a[href*="/artist/"], .bar a[href*="/artist/"]');
      if (artistLink) {
        const mAr = (artistLink.getAttribute('href') || '').match(/artist\/(\d+)/);
        if (mAr) artistId = mAr[1];
      }
    }

    // 5. Check URL
    if (!trackId) {
      const mUrl = window.location.pathname.match(/track\/(\d+)/);
      if (mUrl) trackId = mUrl[1];
    }
    if (!albumId) {
      const mAl = window.location.pathname.match(/album\/(\d+)/);
      if (mAl) albumId = mAl[1];
    }

    // 6. MediaSession metadata fallback
    if ((!title || !artist) && navigator.mediaSession?.metadata) {
      const meta = navigator.mediaSession.metadata;
      if (!title) title = meta.title || '';
      if (!artist) artist = meta.artist || '';
      if (!album) album = meta.album || '';
      if (!cover && meta.artwork && meta.artwork.length > 0) {
        cover = meta.artwork[meta.artwork.length - 1].src;
      }
    }

    // 7. DOM text fallbacks
    if (!title) {
      const titleEl = document.querySelector('[data-test-id="track-title"], [data-test-id="TRACK_TITLE"], [class*="TrackTitle"], .track__title, .track__name a, [class*="trackName"], [class*="PlayerBar"] a[href*="/album/"], .bar .track-title');
      if (titleEl) title = titleEl.textContent.trim();
    }

    if (!artist) {
      const artistEl = document.querySelector('[data-test-id="track-artist"], [data-test-id="TRACK_ARTIST"], [class*="TrackArtists"], .track__artists, .track__artists a, [class*="artistName"], [class*="PlayerBar"] a[href*="/artist/"], .bar .track-artists');
      if (artistEl) artist = artistEl.textContent.trim();
    }

    if (!cover) {
      const coverEl = document.querySelector('[data-test-id="track-cover"] img, [class*="Cover_image"], .track-cover img, .entity-cover__image, [class*="track-cover"] img, [class*="PlayerBar"] img, .bar img');
      if (coverEl) cover = coverEl.src;
    }

    if (duration === 0) {
      if (activeAudioEl && !isNaN(activeAudioEl.duration) && activeAudioEl.duration > 0) {
        duration = Math.round(activeAudioEl.duration);
      } else {
        const durEl = document.querySelector('[data-test-id="progress-duration"], .progress__right, [class*="progress__right"], [class*="duration"]');
        if (durEl) duration = parseTime(durEl.textContent);
      }
    }

    // Normalize trackId if formatted as "12345:678"
    if (typeof trackId === 'string' && trackId.includes(':')) {
      const parts = trackId.split(':');
      trackId = parts[0];
      if (!albumId) albumId = parts[1];
    }

    return {
      id: trackId ? String(trackId) : null,
      trackId: trackId ? String(trackId) : null,
      albumId: albumId ? String(albumId) : null,
      title: title || lastTitle,
      artist: artist,
      album: album || 'Яндекс Музыка',
      cover: cover,
      duration: duration || (activeAudioEl?.duration ? Math.round(activeAudioEl.duration) : 0),
      permalink: permalink || (trackId
        ? (albumId ? `https://music.yandex.ru/album/${albumId}/track/${trackId}` : `https://music.yandex.ru/track/${trackId}`)
        : window.location.href),
      artistUrl: artistId ? `https://music.yandex.ru/artist/${artistId}` : ''
    };
  }

  function extractAndEmitTrack() {
    const meta = findCurrentTrackMeta();
    if (meta.title && (meta.title !== lastTitle || (meta.trackId && String(meta.trackId) !== String(window._lastEmittedTrackId)))) {
      lastTitle = meta.title;
      window._lastEmittedTrackId = meta.trackId;
      emit('track', meta);
    }
  }

  // Accurate player control button resolution
  function getYandexPlayerButtons() {
    const shuffleBtn = document.querySelector('[data-test-id="CONTROL_SHUFFLE"]') ||
                       document.querySelector('[data-test-id="CONTROL_RANDOM"]') ||
                       document.querySelector('[data-test-id="SHUFFLE_BUTTON"]') ||
                       document.querySelector('[data-test-id="shuffle-button"]') ||
                       document.querySelector('[data-test-id="player-action-shuffle"]') ||
                       document.querySelector('button[aria-label*="еремеш"]') ||
                       document.querySelector('button[aria-label*="орядок"]') ||
                       document.querySelector('button[aria-label*="huffle"]') ||
                       document.querySelector('button[title*="еремеш"]') ||
                       document.querySelector('button[title*="huffle"]') ||
                       document.querySelector('.player-controls__btn_shuffle') ||
                       document.querySelector('button[class*="player-controls__btn_shuffle"]') ||
                       document.querySelector('button[class*="shuffleButton"]') ||
                       document.querySelector('button[class*="Shuffle"]');

    const repeatBtn = document.querySelector('[data-test-id="CONTROL_REPEAT"]') ||
                      document.querySelector('[data-test-id="REPEAT_BUTTON"]') ||
                      document.querySelector('[data-test-id="player-action-repeat"]') ||
                      document.querySelector('[data-test-id="repeat-button"]') ||
                      document.querySelector('button[aria-label*="овтор"]') ||
                      document.querySelector('button[aria-label*="epeat"]') ||
                      document.querySelector('button[title*="овтор"]') ||
                      document.querySelector('button[title*="epeat"]') ||
                      document.querySelector('.player-controls__btn_repeat') ||
                      document.querySelector('button[class*="player-controls__btn_repeat"]') ||
                      document.querySelector('button[class*="repeatButton"]') ||
                      document.querySelector('button[class*="Repeat"]');

    const nextBtn = document.querySelector('[data-test-id="CONTROL_FORWARD"]') ||
                    document.querySelector('[data-test-id="CONTROL_NEXT"]') ||
                    document.querySelector('[data-test-id="NEXT_TRACK"]') ||
                    document.querySelector('[data-test-id="player-action-next"]') ||
                    document.querySelector('button[aria-label*="ледующ"]') ||
                    document.querySelector('button[aria-label*="перёд"]') ||
                    document.querySelector('button[aria-label*="ext"]') ||
                    document.querySelector('.player-controls__btn_next') ||
                    document.querySelector('button[class*="player-controls__btn_next"]') ||
                    document.querySelector('button[class*="nextButton"]');

    const prevBtn = document.querySelector('[data-test-id="CONTROL_BACKWARD"]') ||
                    document.querySelector('[data-test-id="CONTROL_PREV"]') ||
                    document.querySelector('[data-test-id="PREVIOUS_TRACK"]') ||
                    document.querySelector('[data-test-id="player-action-prev"]') ||
                    document.querySelector('button[aria-label*="редыдущ"]') ||
                    document.querySelector('button[aria-label*="азад"]') ||
                    document.querySelector('button[aria-label*="rev"]') ||
                    document.querySelector('.player-controls__btn_prev') ||
                    document.querySelector('button[class*="player-controls__btn_prev"]') ||
                    document.querySelector('button[class*="prevButton"]');

    return { shuffleBtn, repeatBtn, nextBtn, prevBtn };
  }

  // Layout position fallback: in modern Yandex bar, buttons are [Shuffle] [Prev] [Play] [Next] [Repeat]
  function findControlsByLayout() {
    const playBtn = document.querySelector('[data-test-id="CONTROL_PLAY"]') ||
                    document.querySelector('[data-test-id="CONTROL_PAUSE"]') ||
                    document.querySelector('.player-controls__btn_play') ||
                    document.querySelector('.player-controls__btn_pause') ||
                    document.querySelector('button[class*="playButton"]');
    if (!playBtn) return {};

    const container = playBtn.closest('[class*="Controls"], [class*="PlayerBar"], .player-controls, footer');
    if (!container) return {};

    const buttons = Array.from(container.querySelectorAll('button'));
    const playIndex = buttons.indexOf(playBtn);
    if (playIndex === -1) return {};

    let shuffleBtn = null;
    let prevBtn = null;
    let nextBtn = null;
    let repeatBtn = null;

    if (playIndex >= 2) {
      shuffleBtn = buttons[0];
      prevBtn = buttons[playIndex - 1];
    } else if (playIndex >= 1) {
      prevBtn = buttons[playIndex - 1];
    }

    if (buttons.length > playIndex + 1) {
      nextBtn = buttons[playIndex + 1];
    }
    if (buttons.length > playIndex + 2) {
      repeatBtn = buttons[buttons.length - 1];
    }

    return { shuffleBtn, repeatBtn, nextBtn, prevBtn };
  }

  function isShuffleActive(btn) {
    if (!btn) return false;
    const ariaChecked = btn.getAttribute('aria-checked');
    const ariaPressed = btn.getAttribute('aria-pressed');
    if (ariaChecked === 'true' || ariaPressed === 'true') return true;
    if (ariaChecked === 'false' || ariaPressed === 'false') return false;

    const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
    const title = (btn.getAttribute('title') || '').toLowerCase();
    if (aria.includes('выключить') || title.includes('выключить')) return true;
    if (aria.includes('включить') || title.includes('включить')) return false;

    const cls = btn.className || '';
    if (typeof cls === 'string' && (cls.includes('active') || cls.includes('Active') || cls.includes('selected') || cls.includes('checked'))) return true;

    return false;
  }

  function getYandexRepeatMode() {
    let { repeatBtn } = getYandexPlayerButtons();
    if (!repeatBtn) {
      const layout = findControlsByLayout();
      repeatBtn = layout.repeatBtn;
    }
    if (!repeatBtn) return 'none';

    const aria = (repeatBtn.getAttribute('aria-label') || '').toLowerCase();
    const title = (repeatBtn.getAttribute('title') || '').toLowerCase();
    const ariaChecked = repeatBtn.getAttribute('aria-checked');
    const ariaPressed = repeatBtn.getAttribute('aria-pressed');

    // 1. Repeat one detection
    if (ariaChecked === 'mixed' ||
        aria.includes('один') || aria.includes('трек') || aria.includes('one') || aria.includes('1') ||
        title.includes('один') || title.includes('трек') || title.includes('one') || title.includes('1')) {
      return 'one';
    }

    const cls = repeatBtn.className || '';
    if (typeof cls === 'string' && (cls.includes('repeat_one') || cls.includes('repeat-one') || cls.includes('RepeatOne'))) {
      return 'one';
    }

    const hasOneText = Array.from(repeatBtn.querySelectorAll('*')).some(el => (el.textContent || '').trim() === '1');
    if (hasOneText) return 'one';

    // 2. Repeat all detection
    if (ariaChecked === 'true' || ariaPressed === 'true' ||
        aria.includes('контекст') || aria.includes('все') || aria.includes('all') ||
        title.includes('контекст') || title.includes('все') || title.includes('all')) {
      return 'all';
    }
    if (typeof cls === 'string' && (cls.includes('active') || cls.includes('Active') || cls.includes('checked') || cls.includes('selected'))) {
      return 'all';
    }

    return 'none';
  }

  function checkState() {
    hookExternalApi();

    let isPlaying = false;
    if (activeAudioEl) {
      isPlaying = !activeAudioEl.paused;
    } else if (window.externalAPI && typeof window.externalAPI.isPlaying === 'function') {
      try { isPlaying = window.externalAPI.isPlaying(); } catch (e) {}
    } else {
      const playBtn = document.querySelector('[data-test-id="CONTROL_PLAY"]') ||
                      document.querySelector('[data-test-id="CONTROL_PAUSE"]') ||
                      document.querySelector('[data-test-id="player-action-play"]') ||
                      document.querySelector('[data-test-id="player-action-pause"]') ||
                      document.querySelector('.player-controls__btn_play') ||
                      document.querySelector('.player-controls__btn_pause') ||
                      document.querySelector('button[class*="player-controls__btn_play"]');
      if (playBtn) {
        isPlaying = playBtn.classList.contains('player-controls__btn_pause') ||
                    playBtn.classList.contains('playing') ||
                    (playBtn.getAttribute('data-test-id') || '').includes('PAUSE') ||
                    (playBtn.getAttribute('aria-label') || '').toLowerCase().includes('пауза');
      }
    }

    if (isPlaying !== lastState) {
      lastState = isPlaying;
      emit('state', { isPlaying });
    }

    extractAndEmitTrack();

    // Check repeat mode state from UI
    const currentRepeat = getYandexRepeatMode();
    if (currentRepeat && currentRepeat !== lastRepeatMode) {
      lastRepeatMode = currentRepeat;
      window._repeatMode = currentRepeat;
      if (activeAudioEl) {
        activeAudioEl.loop = (currentRepeat === 'one');
      }
      emit('repeat', { mode: currentRepeat });
    }

    // Check shuffle state from UI
    let { shuffleBtn } = getYandexPlayerButtons();
    if (!shuffleBtn) {
      const layout = findControlsByLayout();
      shuffleBtn = layout.shuffleBtn;
    }
    if (shuffleBtn) {
      const isShuffled = isShuffleActive(shuffleBtn);
      if (lastShuffleState !== isShuffled) {
        lastShuffleState = isShuffled;
        emit('shuffle', { isShuffle: isShuffled });
      }
    }

    // Fallback progress
    if (isPlaying && (!activeAudioEl || isNaN(activeAudioEl.duration) || activeAudioEl.duration === 0)) {
      const curEl = document.querySelector('[data-test-id="progress-current"]') ||
                    document.querySelector('.progress__left') ||
                    document.querySelector('[class*="progress__left"]');
      const durEl = document.querySelector('[data-test-id="progress-duration"]') ||
                    document.querySelector('.progress__right') ||
                    document.querySelector('[class*="progress__right"]');
      if (curEl && durEl) {
        emit('progress', {
          position: parseTime(curEl.textContent),
          duration: parseTime(durEl.textContent)
        });
      }
    }
  }

  // ---- Like of the current track (heart in the app's player bar) ----
  // The bottom bar and the "Моя волна" bar both render a like button; take the visible one
  function findLikeButton() {
    const byId = document.querySelector('[class*="PlayerBar"] [data-test-id="LIKE_BUTTON"], [data-test-id="PLAYERBAR_DESKTOP_LIKE_BUTTON"]');
    if (byId) return byId;
    const candidates = [...document.querySelectorAll('[class*="PlayerBar"] button[aria-label]')].filter(b => {
      const label = b.getAttribute('aria-label') || '';
      return /нравится|like/i.test(label) && !/не нравится|dislike|сбросить|волн/i.test(label);
    });
    return candidates.find(b => b.offsetParent !== null) || candidates[0] || null;
  }

  function getLikeState() {
    const btn = findLikeButton();
    if (!btn) return null;
    const label = btn.getAttribute('aria-label') || '';
    return btn.getAttribute('aria-pressed') === 'true' || /убрать|удалить|unlike/i.test(label);
  }

  let lastLikeState;
  function checkLike() {
    const liked = getLikeState();
    if (liked !== lastLikeState) {
      lastLikeState = liked;
      emit('like', { liked });
    }
  }

  function toggleLike() {
    const btn = findLikeButton();
    if (!btn) return Promise.resolve(null);
    btn.click();
    return new Promise(resolve => setTimeout(() => { checkLike(); resolve(getLikeState()); }, 450));
  }

  setInterval(checkState, 600);
  setInterval(checkLike, 700);

  // Commands
  // ---- Play queue ------------------------------------------------------------
  // The queue exists in the DOM only inside the fullscreen player ("Очередь воспроизведения").
  // It is opened invisibly, read, and closed again unless the user had it open already.
  // Blocks: PlayQueueBeforePlayingBlock (played in the current playlist/album),
  // PlayQueueNowPlayingBlock (current), PlayQueueAfterPlayingBlock (up next).
  const qSleep = (ms) => new Promise(r => setTimeout(r, ms));
  let queueBusy = Promise.resolve();
  const QUEUE_BLOCKS = {
    history: 'PlayQueueBeforePlayingBlock',
    current: 'PlayQueueNowPlayingBlock',
    upcoming: 'PlayQueueAfterPlayingBlock'
  };

  function queueRows(block) {
    return Array.from(document.querySelectorAll(`[class*="${QUEUE_BLOCKS[block]}"] [class*="CommonTrack_root"]`));
  }

  function withQueuePanel(task) {
    const run = async () => {
      const alreadyOpen = !!document.querySelector('[class*="PlayQueue_root"]');
      let style = null;
      if (!alreadyOpen) {
        const btn = document.querySelector('button[aria-label="Очередь воспроизведения"]');
        if (!btn) return null;
        style = document.createElement('style');
        style.textContent = '[class*="FullscreenPlayer"] { opacity: 0 !important; pointer-events: none !important; }';
        document.documentElement.appendChild(style);
        btn.click();
        for (let i = 0; i < 30 && !document.querySelector('[class*="PlayQueue_root"]'); i++) await qSleep(50);
        await qSleep(300);
      }
      try {
        return await task();
      } finally {
        if (!alreadyOpen) {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
          setTimeout(() => style && style.remove(), 700);
        }
      }
    };
    const next = queueBusy.then(run, run);
    queueBusy = next.catch(() => {});
    return next;
  }

  function readQueueRow(row, block, index) {
    const trackLink = row.querySelector('a[href*="/track/"]');
    const artists = Array.from(row.querySelectorAll('a[href*="/artist/"]')).map(a => a.textContent.trim()).filter(Boolean);
    const img = row.querySelector('img');
    const durText = Array.from(row.querySelectorAll('span[aria-hidden="true"]')).map(s => s.textContent.trim()).find(t => /^\d+:\d\d$/.test(t)) || '';
    const cover = img ? (img.getAttribute('src') || '').replace(/\/\d+x\d+$/, '/200x200') : null;
    return {
      key: { block, index },
      title: trackLink ? trackLink.textContent.trim() : (row.getAttribute('aria-label') || ''),
      artist: artists.join(', '),
      cover: cover || null,
      duration: parseTime(durText),
      permalink: trackLink ? new URL(trackLink.getAttribute('href'), location.origin).href : ''
    };
  }

  function getQueue() {
    return withQueuePanel(async () => {
      if (!document.querySelector('[class*="PlayQueue_root"]')) return null;
      const read = (block) => queueRows(block).map((row, i) => readQueueRow(row, block, i));
      const titleEl = document.querySelector('[class*="PlayQueueTitle_root"]');
      return {
        context: titleEl ? titleEl.textContent.replace(/\s+/g, ' ').trim() : '',
        history: read('history'),
        current: read('current')[0] || null,
        upcoming: read('upcoming')
      };
    });
  }

  function playQueueItem(key) {
    return withQueuePanel(async () => {
      if (!key || !QUEUE_BLOCKS[key.block]) return false;
      const row = queueRows(key.block)[key.index];
      const btn = row && row.querySelector('[class*="PlayButtonWithCover"] button');
      if (!btn) return false;
      btn.click();
      await qSleep(400);
      return true;
    });
  }

  function navigateInApp(url) {
    let target;
    try { target = new URL(url, window.location.origin); } catch (e) { return; }
    if (target.origin !== window.location.origin) {
      window.location.assign(target.href);
      return;
    }
    const path = target.pathname + target.search;
    if (window.location.pathname + window.location.search === path) return;

    // Prefer a real in-app link: the SPA router intercepts clicks on it without reloading
    const link = Array.from(document.querySelectorAll('a[href]')).find(a => {
      try {
        const u = new URL(a.href, window.location.origin);
        return u.pathname === target.pathname && u.search === target.search;
      } catch (e) { return false; }
    });
    if (link) {
      link.click();
      return;
    }
    if (window.next && window.next.router && typeof window.next.router.push === 'function') {
      window.next.router.push(path);
      return;
    }
    window.location.assign(target.href);
  }

  // ---- Audio levels for the app's beat-reactive background ------------------
  // An analyser is attached to the end of our EQ chain (the page audio passes through it);
  // 16 log-spaced bands (0..255) are sent ~30 times a second, only while the app asks for them.
  const LEVEL_BANDS = 16;
  const chainAnalysers = new WeakMap();
  let levelsTimer = null;

  function analyserForChain(chain) {
    let analyser = chainAnalysers.get(chain);
    if (!analyser) {
      try {
        analyser = chain.ctx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.55;
        rawAudioNodeConnect.call(chain.lastFilter, analyser);
        chainAnalysers.set(chain, analyser);
      } catch (e) {
        return null;
      }
    }
    return analyser;
  }

  function sampleLevels() {
    let best = null;
    let bestSum = 0;
    for (const chain of allActiveChains) {
      const analyser = analyserForChain(chain);
      if (!analyser) continue;
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      if (sum > bestSum) {
        bestSum = sum;
        best = { data, nyquist: chain.ctx.sampleRate / 2 };
      }
    }
    if (!best) return null;
    const { data, nyquist } = best;
    const bands = [];
    for (let b = 0; b < LEVEL_BANDS; b++) {
      const f0 = 30 * Math.pow(16000 / 30, b / LEVEL_BANDS);
      const f1 = 30 * Math.pow(16000 / 30, (b + 1) / LEVEL_BANDS);
      const i0 = Math.floor((f0 / nyquist) * data.length);
      const i1 = Math.max(i0 + 1, Math.ceil((f1 / nyquist) * data.length));
      let peak = 0;
      for (let i = i0; i < i1 && i < data.length; i++) peak = Math.max(peak, data[i]);
      bands.push(peak);
    }
    return bands;
  }

  function setVisualizer(enabled) {
    clearInterval(levelsTimer);
    levelsTimer = null;
    if (!enabled) return;
    let silentTicks = 0;
    levelsTimer = setInterval(() => {
      const bands = sampleLevels();
      const silent = !bands || bands.every(v => v === 0);
      // Keep the channel quiet while nothing plays (one zero frame lets the app fade out)
      if (silent) {
        if (silentTicks++ === 0) emit('levels', { b: new Array(LEVEL_BANDS).fill(0) });
        return;
      }
      silentTicks = 0;
      emit('levels', { b: bands });
    }, 33);
  }

  window.musicHubBridge = {
    play: function() {
      if (mediaSessionHandlers['play']) {
        try { mediaSessionHandlers['play']({ action: 'play' }); return; } catch(e) {}
      }
      if (window.externalAPI && typeof window.externalAPI.togglePause === 'function') {
        if (!window.externalAPI.isPlaying()) window.externalAPI.togglePause();
        return;
      }
      if (activeAudioEl && activeAudioEl.paused) {
        activeAudioEl.play().catch(() => {});
        return;
      }
      const playBtn = document.querySelector('[data-test-id="CONTROL_PLAY"]') ||
                      document.querySelector('[data-test-id="player-action-play"]') ||
                      document.querySelector('.player-controls__btn_play') ||
                      document.querySelector('button[class*="playButton"]') ||
                      document.querySelector('button[aria-label*="Играть"]') ||
                      document.querySelector('button[aria-label*="Воспроизвести"]');
      if (playBtn) triggerClick(playBtn);
    },

    pause: function() {
      if (mediaSessionHandlers['pause']) {
        try { mediaSessionHandlers['pause']({ action: 'pause' }); } catch(e) {}
      }
      if (window.externalAPI && typeof window.externalAPI.togglePause === 'function') {
        try {
          if (window.externalAPI.isPlaying()) window.externalAPI.togglePause();
        } catch (e) {}
      }
      if (activeAudioEl && !activeAudioEl.paused) {
        try { activeAudioEl.pause(); } catch (e) {}
      }
      const pauseBtn = document.querySelector('[data-test-id="CONTROL_PAUSE"]') ||
                       document.querySelector('[data-test-id="player-action-pause"]') ||
                       document.querySelector('.player-controls__btn_pause') ||
                       document.querySelector('button[aria-label*="Пауза"]');
      if (pauseBtn) triggerClick(pauseBtn);
      document.querySelectorAll('audio, video').forEach(el => { try { el.pause(); } catch (e) {} });
      lastState = false;
      emit('state', { isPlaying: false });
    },

    toggle: function() {
      if (mediaSessionHandlers['play'] && !lastState) {
        try { mediaSessionHandlers['play']({ action: 'play' }); return; } catch(e) {}
      } else if (mediaSessionHandlers['pause'] && lastState) {
        try { mediaSessionHandlers['pause']({ action: 'pause' }); return; } catch(e) {}
      }

      if (window.externalAPI && typeof window.externalAPI.togglePause === 'function') {
        window.externalAPI.togglePause();
        return;
      }
      const playBtn = document.querySelector('[data-test-id="CONTROL_PLAY"]') ||
                      document.querySelector('[data-test-id="CONTROL_PAUSE"]') ||
                      document.querySelector('[data-test-id="player-action-play"]') ||
                      document.querySelector('[data-test-id="player-action-pause"]') ||
                      document.querySelector('.player-controls__btn_play') ||
                      document.querySelector('.player-controls__btn_pause') ||
                      document.querySelector('button[class*="playButton"]');
      if (playBtn) {
        triggerClick(playBtn);
      } else if (activeAudioEl) {
        if (activeAudioEl.paused) activeAudioEl.play().catch(() => {});
        else activeAudioEl.pause();
      } else {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }));
      }
    },

    next: function() {
      // 1. MediaSession Handler
      if (mediaSessionHandlers['nexttrack']) {
        try { mediaSessionHandlers['nexttrack']({ action: 'nexttrack' }); return; } catch(e) {}
      }

      // 2. externalAPI
      if (window.externalAPI && typeof window.externalAPI.next === 'function') {
        try { window.externalAPI.next(); return; } catch(e) {}
      }

      // 3. Named button search
      let { nextBtn } = getYandexPlayerButtons();
      if (!nextBtn) {
        const layout = findControlsByLayout();
        nextBtn = layout.nextBtn;
      }

      if (nextBtn) {
        triggerClick(nextBtn);
        return;
      }

      // 4. Keyboard shortcut
      try {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', code: 'KeyL', bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keyup', { key: 'l', code: 'KeyL', bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', shiftKey: true, bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', code: 'ArrowRight', shiftKey: true, bubbles: true }));
      } catch (e) {}
    },

    prev: function() {
      // 1. MediaSession Handler
      if (mediaSessionHandlers['previoustrack']) {
        try { mediaSessionHandlers['previoustrack']({ action: 'previoustrack' }); return; } catch(e) {}
      }

      // 2. externalAPI
      if (window.externalAPI && typeof window.externalAPI.prev === 'function') {
        try { window.externalAPI.prev(); return; } catch(e) {}
      }

      // 3. Named button search
      let { prevBtn } = getYandexPlayerButtons();
      if (!prevBtn) {
        const layout = findControlsByLayout();
        prevBtn = layout.prevBtn;
      }

      if (prevBtn) {
        triggerClick(prevBtn);
        return;
      }

      // 4. Keyboard shortcut
      try {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ', bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keyup', { key: 'j', code: 'KeyJ', bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', code: 'ArrowLeft', shiftKey: true, bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', code: 'ArrowLeft', shiftKey: true, bubbles: true }));
      } catch (e) {}
    },

    seek: function(percent) {
      const clamped = Math.max(0, Math.min(100, percent));

      if (mediaSessionHandlers['seekto'] && activeAudioEl && activeAudioEl.duration) {
        try {
          mediaSessionHandlers['seekto']({ action: 'seekto', seekTime: (clamped / 100) * activeAudioEl.duration });
          return;
        } catch(e) {}
      }

      // 1. Direct HTML5 audio seek
      if (activeAudioEl && !isNaN(activeAudioEl.duration) && activeAudioEl.duration > 0) {
        activeAudioEl.currentTime = (clamped / 100) * activeAudioEl.duration;
      }

      // 2. externalAPI seek
      if (window.externalAPI && typeof window.externalAPI.setPosition === 'function') {
        try {
          const track = window.externalAPI.getCurrentTrack();
          if (track && track.duration) {
            window.externalAPI.setPosition((clamped / 100) * track.duration);
          }
        } catch (e) {}
      }

      // 3. Dispatch click to Yandex progress bar
      const progressBar = document.querySelector('[data-test-id="progress-bar"]') ||
                          document.querySelector('[data-test-id="PROGRESS_BAR"]') ||
                          document.querySelector('.progress__bar') ||
                          document.querySelector('.progress') ||
                          document.querySelector('[class*="ProgressBar"]') ||
                          document.querySelector('.player-controls__progress');
      if (progressBar) {
        const rect = progressBar.getBoundingClientRect();
        const clientX = rect.left + (clamped / 100) * rect.width;
        const clientY = rect.top + rect.height / 2;

        const eventOpts = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX,
          clientY,
          screenX: clientX,
          screenY: clientY,
          pageX: clientX,
          pageY: clientY,
          button: 0,
          buttons: 1
        };

        progressBar.dispatchEvent(new PointerEvent('pointerdown', eventOpts));
        progressBar.dispatchEvent(new MouseEvent('mousedown', eventOpts));
        progressBar.dispatchEvent(new PointerEvent('pointerup', eventOpts));
        progressBar.dispatchEvent(new MouseEvent('mouseup', eventOpts));
        progressBar.dispatchEvent(new MouseEvent('click', eventOpts));
      }
    },

    setVolume: function(val) {
      const clamped = Math.max(0, Math.min(1, val));
      window._currentVolume = clamped;

      if (window.externalAPI && typeof window.externalAPI.setVolume === 'function') {
        try { window.externalAPI.setVolume(clamped); } catch (e) {}
      }

      document.querySelectorAll('audio, video').forEach(el => {
        try { el.volume = clamped; } catch (e) {}
      });
      if (activeAudioEl) {
        try { activeAudioEl.volume = clamped; } catch (e) {}
      }
    },

    setShuffle: function(enable) {
      window._isShuffle = !!enable;

      let { shuffleBtn } = getYandexPlayerButtons();
      if (!shuffleBtn) {
        const layout = findControlsByLayout();
        shuffleBtn = layout.shuffleBtn;
      }

      if (shuffleBtn) {
        const currentActive = isShuffleActive(shuffleBtn);
        if (Boolean(enable) !== currentActive) {
          triggerClick(shuffleBtn);
        }
      } else if (window.externalAPI && typeof window.externalAPI.toggleShuffle === 'function') {
        try {
          const isShuffled = window.externalAPI.getShuffle ? window.externalAPI.getShuffle() : false;
          if (Boolean(enable) !== isShuffled) {
            window.externalAPI.toggleShuffle();
          }
        } catch (e) {}
      }
    },

    toggleShuffle: function() {
      let { shuffleBtn } = getYandexPlayerButtons();
      if (!shuffleBtn) {
        const layout = findControlsByLayout();
        shuffleBtn = layout.shuffleBtn;
      }
      if (shuffleBtn) {
        triggerClick(shuffleBtn);
      } else if (window.externalAPI && typeof window.externalAPI.toggleShuffle === 'function') {
        window.externalAPI.toggleShuffle();
      }
    },

    setRepeat: function(mode) {
      // mode: 'none' | 'all' | 'one'
      window._repeatMode = mode;
      lastRepeatMode = mode;

      document.querySelectorAll('audio, video').forEach(el => {
        el.loop = (mode === 'one');
      });
      if (activeAudioEl) {
        activeAudioEl.loop = (mode === 'one');
      }

      let { repeatBtn } = getYandexPlayerButtons();
      if (!repeatBtn) {
        const layout = findControlsByLayout();
        repeatBtn = layout.repeatBtn;
      }

      if (repeatBtn) {
        const current = getYandexRepeatMode();
        if (current === mode) return;

        let neededClicks = 1;
        if ((current === 'none' && mode === 'one') ||
            (current === 'all' && mode === 'none') ||
            (current === 'one' && mode === 'all')) {
          neededClicks = 2;
        }

        triggerClick(repeatBtn);
        if (neededClicks === 2) {
          setTimeout(() => {
            const now = getYandexRepeatMode();
            if (now !== mode && repeatBtn) {
              triggerClick(repeatBtn);
            }
          }, 180);
        }
      } else if (window.externalAPI && typeof window.externalAPI.toggleRepeat === 'function') {
        try {
          window.externalAPI.toggleRepeat();
        } catch(e) {}
      }
    },

    toggleRepeat: function() {
      let { repeatBtn } = getYandexPlayerButtons();
      if (!repeatBtn) {
        const layout = findControlsByLayout();
        repeatBtn = layout.repeatBtn;
      }
      if (repeatBtn) {
        triggerClick(repeatBtn);
      } else if (window.externalAPI && typeof window.externalAPI.toggleRepeat === 'function') {
        window.externalAPI.toggleRepeat();
      }
    },

    setEqualizer: function(config) {
      if (!config) return;
      eqConfig.enabled = config.enabled !== false;
      if (Array.isArray(config.gains)) {
        eqConfig.gains = config.gains;
      }
      initEq();
      applyEqGains();
      document.querySelectorAll('audio, video').forEach(connectAudioToEq);
      if (activeAudioEl) connectAudioToEq(activeAudioEl);
    },

    getCurrentTrack: function() {
      return findCurrentTrackMeta();
    },

    findCurrentPlayingTrack: function() {
      return findCurrentTrackMeta();
    },

    // Open a music.yandex.ru page inside the SPA so playback is not interrupted by a reload
    navigateTo: function(url) {
      navigateInApp(url);
    },

    getQueue: getQueue,
    playQueueItem: playQueueItem,
    setVisualizer: setVisualizer,
    getLike: getLikeState,
    toggleLike: toggleLike
  };

  // Re-apply volume & repeat continuously
  setInterval(() => {
    if (typeof window._currentVolume === 'number') {
      document.querySelectorAll('audio, video').forEach(el => {
        if (Math.abs(el.volume - window._currentVolume) > 0.05) {
          el.volume = window._currentVolume;
        }
      });
    }
    if (window._repeatMode === 'one') {
      document.querySelectorAll('audio, video').forEach(el => {
        if (!el.loop) el.loop = true;
      });
    }
  }, 800);

  // Continuously remove any grey block / capsule wrappers around player buttons
  function stripControlsBackgrounds() {
    try {
      const selector = [
        '[data-test-id="CONTROL_PLAY"]',
        '[data-test-id="CONTROL_PAUSE"]',
        '[data-test-id="CONTROL_FORWARD"]',
        '[data-test-id="CONTROL_BACKWARD"]',
        '[data-test-id*="PLAY"]',
        '[data-test-id*="PAUSE"]',
        'button[class*="playButton"]',
        'button[class*="PlayButton"]',
        '.player-controls__btn_play',
        '.rotor__controls button'
      ].join(',');

      const buttons = document.querySelectorAll(selector);
      buttons.forEach(btn => {
        let parent = btn.parentElement;
        for (let i = 0; i < 4 && parent && parent !== document.body && parent !== document.documentElement; i++) {
          if (parent.classList) {
            const cls = parent.className || '';
            if (typeof cls === 'string' && (
              cls.includes('Controls') ||
              cls.includes('controls') ||
              cls.includes('Buttons') ||
              cls.includes('buttons') ||
              cls.includes('Player') ||
              cls.includes('player') ||
              cls.includes('Group') ||
              cls.includes('group') ||
              cls.includes('Layout') ||
              cls.includes('layout')
            )) {
              parent.style.setProperty('background', 'transparent', 'important');
              parent.style.setProperty('background-color', 'transparent', 'important');
              parent.style.setProperty('border', 'none', 'important');
              parent.style.setProperty('box-shadow', 'none', 'important');
              parent.style.setProperty('backdrop-filter', 'none', 'important');
              parent.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
            }
          }
          parent = parent.parentElement;
        }
      });
    } catch (err) {}
  }

  setInterval(stripControlsBackgrounds, 250);

  // Fix "Для вас и Тренды" tabs layout, section headers and remove grey page backgrounds
  function fixFeedTabsAndBackgrounds() {
    try {
      // 1. Remove dark/grey background from dashboard/feed page containers and section headers
      const transparentTargets = document.querySelectorAll([
        'div[class*="Dashboard_root"]',
        'div[class*="FeedPage_root"]',
        'div[class*="ContentSheet_root"]',
        'div[class*="MainPage_content"]',
        'div[class*="ContentCard_root"]',
        'div[class*="FeedPage"]',
        'div[class*="MainPage"]',
        'div[class*="TrendsPage"]',
        'div[class*="ForYouPage"]',
        'div[class*="FeedContent"]',
        'div[class*="ContentContainer"]',
        'div[class*="Section_header"]',
        'div[class*="SectionHeader"]',
        'div[class*="Block_header"]',
        'div[class*="BlockHeader"]',
        'div[class*="Heading_root"]',
        'div[class*="TitleBlock"]',
        'div[class*="Title_root"]',
        'div[class*="StickyHeader"]',
        'h1', 'h2', 'h3', 'h4'
      ].join(','));

      transparentTargets.forEach(el => {
        el.style.setProperty('background', 'transparent', 'important');
        el.style.setProperty('background-color', 'transparent', 'important');
        el.style.setProperty('border', 'none', 'important');
        el.style.setProperty('box-shadow', 'none', 'important');
        el.style.setProperty('backdrop-filter', 'none', 'important');
        el.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
      });

      // 2. Hide any ghost sliding indicators inside tabs
      document.querySelectorAll([
        'div[class*="SegmentedControl_indicator"]',
        'div[class*="SegmentedControl_slider"]',
        'div[class*="Tabs_indicator"]',
        'div[class*="Tabs_slider"]',
        'div[class*="Tab_indicator"]',
        'div[class*="activeIndicator"]',
        'div[class*="active-indicator"]',
        'span[class*="indicator"]',
        'span[class*="slider"]'
      ].join(',')).forEach(ind => {
        ind.style.setProperty('display', 'none', 'important');
      });

      // 3. Fix tabs switcher ("Для вас" / "Тренды")
      const candidateTabs = Array.from(document.querySelectorAll('a, button, div')).filter(el => {
        const txt = (el.textContent || '').trim();
        return (txt.includes('Для вас') || txt.includes('Тренды')) && el.children.length > 0 && el.children.length < 5;
      });

      candidateTabs.forEach(tab => {
        const cls = tab.className || '';
        if (typeof cls === 'string' && (
          cls.includes('Tab') || cls.includes('tab') ||
          cls.includes('Segment') || cls.includes('segment') ||
          cls.includes('Button') || cls.includes('button') ||
          cls.includes('Item') || cls.includes('item') ||
          cls.includes('Toggle') || cls.includes('toggle')
        )) {
          tab.style.setProperty('display', 'inline-flex', 'important');
          tab.style.setProperty('flex-direction', 'row', 'important');
          tab.style.setProperty('align-items', 'center', 'important');
          tab.style.setProperty('gap', '10px', 'important');
          tab.style.setProperty('position', 'relative', 'important');
          tab.style.setProperty('left', 'auto', 'important');
          tab.style.setProperty('top', 'auto', 'important');
          tab.style.setProperty('width', 'auto', 'important');
          tab.style.setProperty('height', 'auto', 'important');
          tab.style.setProperty('margin', '0', 'important');
          tab.style.setProperty('overflow', 'visible', 'important');

          // Parent tabs row: clean container without background/borders
          if (tab.parentElement) {
            tab.parentElement.style.setProperty('display', 'flex', 'important');
            tab.parentElement.style.setProperty('flex-direction', 'row', 'important');
            tab.parentElement.style.setProperty('align-items', 'center', 'important');
            tab.parentElement.style.setProperty('gap', '12px', 'important');
            tab.parentElement.style.setProperty('background', 'transparent', 'important');
            tab.parentElement.style.setProperty('border', 'none', 'important');
            tab.parentElement.style.setProperty('box-shadow', 'none', 'important');
          }

          // Check inner text containers
          Array.from(tab.children).forEach(child => {
            const hasImgs = child.querySelector('img, svg') !== null || child.tagName === 'IMG' || child.tagName === 'SVG';
            if (hasImgs) {
              child.style.setProperty('display', 'flex', 'important');
              child.style.setProperty('align-items', 'center', 'important');
              child.style.setProperty('position', 'static', 'important');
              child.style.setProperty('flex-shrink', '0', 'important');
            } else {
              child.style.setProperty('display', 'flex', 'important');
              child.style.setProperty('flex-direction', 'column', 'important');
              child.style.setProperty('position', 'static', 'important');
              child.style.setProperty('align-items', 'flex-start', 'important');
              child.style.setProperty('justify-content', 'center', 'important');
              child.style.setProperty('line-height', '1.25', 'important');
              Array.from(child.children).forEach(line => {
                line.style.setProperty('position', 'static', 'important');
                line.style.setProperty('display', 'block', 'important');
                line.style.setProperty('margin', '0', 'important');
              });
            }
          });
        }
      });
    } catch (err) {}
  }

  setInterval(fixFeedTabsAndBackgrounds, 300);

  console.log('Yandex Music Bridge successfully attached and ready');
})();
