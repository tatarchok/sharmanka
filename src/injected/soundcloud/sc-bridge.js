// SoundCloud Bridge for Music Hub
(function() {
  if (window._musicHubBridgeLoaded) return;
  window._musicHubBridgeLoaded = true;

  function emit(event, data) {
    console.log('MUSICHUB_BRIDGE|' + JSON.stringify({
      service: 'soundcloud',
      event,
      data
    }));
  }

  let activeAudioEl = null;
  let lastTitle = '';
  let lastState = false;
  let lastRepeatMode = '';
  let lastShuffleState = null;
  window._currentVolume = typeof window._currentVolume === 'number' ? window._currentVolume : 0.8;

  const SC_CLEANER_CSS = `
    /* MusicHub SoundCloud Ad & Annoyance Cleaner */
    /* Screen 1: Player Audio Ad Companion Card / Ad Popup */
    .audibleAd,
    .audibleAdContainer,
    .audibleAd__container,
    .audibleAd__header,
    .audibleAd__artwork,
    .audibleAd__content,
    .audibleAd__dismiss,
    .audibleAd__info,
    .playControls__companion,
    .playControls__companionWrapper,
    .playControls__ad,
    .visualSoundAd,
    .visualAd,
    .adNotice,
    .adPlaceholder,
    .commercialAd,
    .ad_overlay,
    .genericAd,
    .toastAd,
    div[class*="audibleAd"],
    div[class*="playControls__companion"],
    div[class*="visualSoundAd"],
    div[class*="ad_overlay"],
    div[class*="adNotice"],
    div[class*="adBox"],
    div[class*="adContainer"],
    div[class*="ad-container"],
    div[class*="adWrapper"],
    div[class*="ad-wrapper"],
    div[class*="adSlot"],
    div[class*="ad-slot"],
    div[class*="commercialAd"],
    div[data-test-id^="ad"],
    div[data-test-id*="-ad-"],
    div[data-test-id*="Ad"],
    div[data-testid^="ad"],
    div[data-testid*="-ad-"],
    div[data-testid*="Ad"] {
      display: none !important;
      visibility: hidden !important;
      opacity: 0 !important;
      pointer-events: none !important;
      width: 0 !important;
      height: 0 !important;
      min-height: 0 !important;
      max-height: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
      border: none !important;
      overflow: hidden !important;
      position: absolute !important;
      left: -9999px !important;
      top: -9999px !important;
      z-index: -9999 !important;
    }

    /* Screen 2: Top Header Announcement & Creator Promo Banners */
    .announcementBanner,
    .announcement,
    .announcements,
    .announcement__content,
    .announcementBar,
    .announcementBar__wrapper,
    .l-product-banners,
    .l-announcement,
    .l-announcements,
    .header__banner,
    .header__creatorUpsell,
    .header__upsellWrapper,
    .header__upsell,
    .header__goUpsell,
    .creatorSubscriptionsButton,
    .topBanner,
    .topNotification,
    .top-banner,
    .top_banner,
    .upsellBanner,
    .upsell-banner,
    .creatorBar,
    div[class*="announcement"],
    div[class*="announcementBar"],
    div[class*="announcementBanner"],
    div[class*="topBanner"],
    div[class*="topNotification"],
    div[class*="header__banner"],
    div[class*="creatorBanner"],
    div[class*="upsellBanner"],
    div[class*="productBanner"],
    .banner.m-warning,
    .banner.m-promotion,
    .banner.m-announcement {
      display: none !important;
      visibility: hidden !important;
      opacity: 0 !important;
      pointer-events: none !important;
      height: 0 !important;
      min-height: 0 !important;
      max-height: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
      border: none !important;
      overflow: hidden !important;
    }

    /* Screen 3: "GO MOBILE" & Download App Promo Boxes */
    .mobileApps,
    .mobileAppsModule,
    .mobileAppsButtons,
    .mobileAppsButtons.m-sidebar,
    .mobileApps__dismiss,
    .mobileApps__button,
    .mobileApps__container,
    .appPromo,
    .app-promo,
    .go-mobile-banner,
    .promo-banner,
    .sidebarModule__mobile,
    .mobileBadge,
    .mobilePromo,
    .dashbox__wrapper,
    .dashbox__box,
    div[class*="mobileApps"],
    div[class*="appPromo"],
    div[class*="goMobile"],
    div[class*="GoMobile"],
    div[class*="downloadApp"],
    div[class*="DownloadApp"],
    .sidebarModule:has(a[href*="apple.com"]),
    .sidebarModule:has(a[href*="itunes.apple.com"]),
    .sidebarModule:has(a[href*="play.google.com"]),
    .sidebarModule:has(a[href*="apps.apple.com"]),
    .sidebarModule:has(img[alt*="App Store"]),
    .sidebarModule:has(img[alt*="Google Play"]),
    .sidebarModule:has(a[href*="soundcloud.com/mobile"]) {
      display: none !important;
      visibility: hidden !important;
      opacity: 0 !important;
      pointer-events: none !important;
      height: 0 !important;
      min-height: 0 !important;
      max-height: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
      border: none !important;
      overflow: hidden !important;
    }

    /* General: Sidebar Ads, Upsells, and Ad Iframes */
    .l-sidebar-ad,
    .sidebarAd,
    .sidebarAd--display,
    .sidebarAd__container,
    .stream__sidebar .sidebarModule:has(.g-upsell-container),
    .stream__sidebar .sidebarModule:has(a[href*="soundcloud-go"]),
    .stream__sidebar .sidebarModule:has(a[href*="checkout"]),
    .stream__sidebar .sidebarModule:has(a[href*="pro"]),
    .g-upsell-container,
    .listenUpsell,
    .ad-slot,
    .ad-container,
    iframe[src*="adzerk"],
    iframe[src*="doubleclick"],
    iframe[src*="googlesyndication"] {
      display: none !important;
      visibility: hidden !important;
      height: 0 !important;
      max-height: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
      overflow: hidden !important;
    }

    /* MusicHub SoundCloud In-Track Download Buttons */
    .musichub-sc-download-btn {
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      gap: 4px !important;
      cursor: pointer !important;
      border-radius: 3px !important;
      font-family: inherit !important;
      font-size: 11px !important;
      font-weight: 500 !important;
      padding: 2px 8px !important;
      height: 26px !important;
      margin: 0 4px !important;
      background: rgba(255, 85, 0, 0.15) !important;
      border: 1px solid rgba(255, 85, 0, 0.45) !important;
      color: #ff5500 !important;
      transition: all 0.2s ease !important;
      vertical-align: middle !important;
      z-index: 2 !important;
      box-sizing: border-box !important;
      text-decoration: none !important;
      user-select: none !important;
    }

    .musichub-sc-download-btn:hover {
      background: #ff5500 !important;
      color: #ffffff !important;
      border-color: #ff5500 !important;
    }

    .musichub-sc-download-btn.downloading {
      opacity: 0.7 !important;
      pointer-events: none !important;
    }

    .musichub-sc-download-btn.downloading svg {
      animation: sc-dl-spin 1s linear infinite !important;
    }

    @keyframes sc-dl-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `;

  function ensureCleanerStyle() {
    try {
      if (!document.getElementById('musichub-sc-cleaner-style')) {
        const style = document.createElement('style');
        style.id = 'musichub-sc-cleaner-style';
        style.textContent = SC_CLEANER_CSS;
        const target = document.head || document.documentElement;
        if (target) target.appendChild(style);
      }
    } catch(e) {}
  }
  ensureCleanerStyle();

  function cleanSoundCloudAnnoyances() {
    ensureCleanerStyle();
    try {
      const targets = document.querySelectorAll(
        '.audibleAd, .audibleAdContainer, .audibleAd__container, .playControls__companion, ' +
        '.playControls__companionWrapper, .playControls__ad, .visualSoundAd, .visualAd, ' +
        '.adNotice, .adPlaceholder, .commercialAd, .toastAd, .ad_overlay, ' +
        '.announcementBanner, .announcement, .announcements, .announcementBar, .announcementBar__wrapper, ' +
        '.l-product-banners, .l-announcement, .l-announcements, .header__banner, .header__creatorUpsell, ' +
        '.header__upsellWrapper, .header__upsell, .header__goUpsell, .creatorSubscriptionsButton, ' +
        '.topBanner, .topNotification, .top-banner, .upsellBanner, .creatorBar, ' +
        '.mobileApps, .mobileAppsModule, .mobileAppsButtons, .mobileAppsButtons.m-sidebar, ' +
        '.appPromo, .app-promo, .go-mobile-banner, .promo-banner, .sidebarModule__mobile, ' +
        '.dashbox__wrapper, .dashbox__box, .l-sidebar-ad, .sidebarAd, ' +
        '.header__appnextbtn, .header__apppreviousbtn, .header__appclosebtn, ' +
        '.header__appmaximizebtn, .header__appminimizebtn, .playControls__pluginbtn, ' +
        '.playControls__themebtn, .playControls__lyricbtn, .playControls__showcasebtn'
      );
      targets.forEach(el => {
        try { el.remove(); } catch(e) {}
      });
    } catch(e) {}
  }

  let lastTrackContext = null;

  // Track title links, in priority order. querySelector('a, b, c') returns the first match in
  // DOCUMENT order, not in selector order — in feed cards the uploader link comes before the
  // title, so a combined selector picked the profile URL and the download failed.
  const TRACK_TITLE_SELECTORS = [
    'a.soundTitle__title', '.soundTitle__title',
    'a.soundTitle__titleLink',
    'a.compactTrackListItem__trackTitle', '.compactTrackListItem__trackTitle',
    'a.trackItem__trackTitle', '.trackItem__trackTitle',
    '.soundTitle a[href]'
  ];

  // First path segments that are site sections, not users
  const RESERVED_ROOTS = new Set([
    'you', 'discover', 'feed', 'search', 'stations', 'charts', 'upload', 'settings', 'messages',
    'notifications', 'pages', 'terms-of-use', 'pro', 'go', 'mobile', 'people', 'tags', 'signin'
  ]);
  // Second segments that are profile tabs, not tracks (/user/likes, /user/sets ...)
  const PROFILE_TABS = new Set([
    'likes', 'reposts', 'tracks', 'albums', 'sets', 'followers', 'following', 'comments',
    'popular-tracks', 'spotlight', 'toptracks'
  ]);

  // /user/track or /user/sets/playlist (downloadable), never /user or /user/likes
  function toTrackUrl(href) {
    if (!href || href === '#' || href.startsWith('javascript:')) return null;
    let u;
    try { u = new URL(href, 'https://soundcloud.com'); } catch (e) { return null; }
    if (!/(^|\.)soundcloud\.com$/.test(u.hostname)) return null;
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs.length < 2 || RESERVED_ROOTS.has(segs[0])) return null;
    if (segs.length === 2 && PROFILE_TABS.has(segs[1])) return null;
    if (segs[1] === 'sets' && segs.length < 3) return null;
    return `https://soundcloud.com/${segs.join('/')}`;
  }

  function findTrackLink(card) {
    if (!card) return null;
    for (const sel of TRACK_TITLE_SELECTORS) {
      const el = card.querySelector(sel);
      if (!el) continue;
      const a = el.tagName === 'A' ? el : (el.closest('a[href]') || el.querySelector('a[href]'));
      const url = a && toTrackUrl(a.getAttribute('href') || a.href);
      if (url) return { url, title: (a.title || el.textContent || '').trim() };
    }
    // Fallback: any link in the card that points to a track (skip uploader/avatar links)
    for (const a of card.querySelectorAll('a[href]')) {
      if (a.matches('.soundTitle__username, .sound__trackUsername, [class*="username"], [class*="userBadge"], [class*="avatar"]')) continue;
      const url = toTrackUrl(a.getAttribute('href'));
      if (url) return { url, title: (a.title || a.textContent || '').trim() };
    }
    return null;
  }

  const TRACK_CARD_SELECTOR =
    '.sound, .soundList__item, .trackItem, .compactTrackListItem, ' +
    '.searchList__item, .userStreamItem, .listenHero, .fullListenHero, ' +
    '.listenEngagement, [data-testid*="track"], article, li';

  function updateTrackContextFromElement(el) {
    if (!el || !el.closest) return;
    const card = el.closest(TRACK_CARD_SELECTOR);
    const link = findTrackLink(card);
    if (link) {
      lastTrackContext = { card, url: link.url, title: link.title };
    }
  }

  ['pointerdown', 'mousedown', 'mouseover', 'focusin'].forEach(evt => {
    document.addEventListener(evt, (e) => {
      updateTrackContextFromElement(e.target);
      setTimeout(injectDropdownDownloadItem, 10);
      setTimeout(injectDropdownDownloadItem, 100);
    }, { capture: true, passive: true });
  });

  function injectDropdownDownloadItem() {
    try {
      const dropdownLists = document.querySelectorAll(
        '.dropdownMenu__list, .dropdownMenu ul, div[role="menu"] ul, ul[role="menu"], ' +
        '.sc-dropdown__list, div[class*="dropdownMenu"] ul, div[class*="moreMenu"] ul, ' +
        '.dropdownContent ul, div[role="menu"]'
      );

      dropdownLists.forEach(list => {
        if (list.querySelector('.musichub-dropdown-download-btn')) return;

        let targetList = list.tagName === 'UL' ? list : list.querySelector('ul') || list;

        let trackUrl = '';
        let trackTitle = '';

        const cardLink = findTrackLink(list.closest(TRACK_CARD_SELECTOR));
        if (cardLink) {
          trackUrl = cardLink.url;
          trackTitle = cardLink.title;
        }

        if (!trackUrl && lastTrackContext && lastTrackContext.url) {
          trackUrl = lastTrackContext.url;
          trackTitle = lastTrackContext.title;
        }

        // On a track/playlist page the page itself is the track
        if (!trackUrl) {
          trackUrl = toTrackUrl(window.location.href) || '';
        }

        if (!trackUrl) return;

        const li = document.createElement('li');
        li.className = 'dropdownMenu__item musichub-dropdown-download-item';
        li.style.cssText = 'list-style: none !important; margin: 0 !important; padding: 0 !important;';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dropdownMenu__link sc-button-dropdown musichub-dropdown-download-btn';
        btn.setAttribute('role', 'menuitem');
        btn.style.cssText = 'display: flex !important; align-items: center !important; width: 100% !important; text-align: left !important; cursor: pointer !important; padding: 8px 12px !important; font-size: 13px !important; color: #ff5500 !important; background: transparent !important; border: none !important; border-top: 1px solid rgba(255,255,255,0.1) !important; font-weight: 600 !important;';

        btn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 -960 960 960" width="16px" fill="#ff5500" style="margin-right: 10px; flex-shrink: 0;">
            <path d="M480-320 280-520l56-58 104 104v-326h80v326l104-104 56 58-280 200ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T760-160H240Z"/>
          </svg>
          <span class="musichub-dl-text">Скачать в медиатеку</span>
        `;

        btn.addEventListener('mouseenter', () => {
          btn.style.backgroundColor = 'rgba(255, 85, 0, 0.15)';
        });
        btn.addEventListener('mouseleave', () => {
          btn.style.backgroundColor = 'transparent';
        });

        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();

          const span = btn.querySelector('.musichub-dl-text');
          if (span) span.textContent = 'Загрузка...';

          emit('downloadTrack', {
            url: trackUrl,
            title: trackTitle
          });

          setTimeout(() => {
            document.body.click();
          }, 350);
        });

        li.appendChild(btn);
        targetList.appendChild(li);
      });
    } catch(e) {}
  }

  function injectInlineDownloadButtons() {
    try {
      const moreButtons = document.querySelectorAll(
        'button.sc-button-more, button[title*="More"], button[aria-label*="More"], ' +
        'button[title*="Ещё"], button[aria-label*="Ещё"], .sc-button-group button.sc-button-icon:last-child'
      );

      moreButtons.forEach(moreBtn => {
        const parent = moreBtn.parentElement;
        if (!parent || parent.querySelector('.musichub-sc-download-btn')) return;

        const card = moreBtn.closest(TRACK_CARD_SELECTOR);
        if (!card) return;

        // Track page hero has no title link — the page URL is the track
        const isHero = card.matches('.listenHero, .fullListenHero, .listenEngagement');
        const pageUrl = isHero ? toTrackUrl(window.location.href) : null;
        const link = pageUrl ? { url: pageUrl, title: document.title } : findTrackLink(card);
        if (!link || !link.url) return;
        const trackUrl = link.url;
        const trackTitle = link.title;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sc-button sc-button-small sc-button-icon sc-button-responsive musichub-sc-download-btn';
        btn.title = `Скачать «${trackTitle || 'трек'}» в медиатеку`;
        btn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" height="14px" viewBox="0 -960 960 960" width="14px" fill="currentColor">
            <path d="M480-320 280-520l56-58 104 104v-326h80v326l104-104 56 58-280 200ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T760-160H240Z"/>
          </svg>
        `;

        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();

          btn.classList.add('downloading');
          emit('downloadTrack', {
            url: trackUrl,
            title: trackTitle
          });

          setTimeout(() => {
            btn.classList.remove('downloading');
          }, 3500);
        });

        parent.insertBefore(btn, moreBtn);
      });
    } catch(e) {}
  }

  cleanSoundCloudAnnoyances();
  injectInlineDownloadButtons();
  injectDropdownDownloadItem();
  setInterval(() => {
    cleanSoundCloudAnnoyances();
    injectInlineDownloadButtons();
    injectDropdownDownloadItem();
  }, 500);

  // Intercept navigator.mediaSession.setActionHandler
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
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
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

  function getSoundCloudPlayButton() {
    return document.querySelector('.playControl') ||
           document.querySelector('.playControls__play') ||
           document.querySelector('button[class*="playControl"]') ||
           document.querySelector('button[title*="Play current"]') ||
           document.querySelector('button[title*="Pause current"]') ||
           document.querySelector('button[aria-label*="Play current"]') ||
           document.querySelector('button[aria-label*="Pause current"]') ||
           document.querySelector('button[title*="Воспроизвести"]') ||
           document.querySelector('button[title*="Пауза"]') ||
           document.querySelector('button[aria-label*="Воспроизвести"]') ||
           document.querySelector('button[aria-label*="Пауза"]');
  }

  function getSoundCloudShuffleButton() {
    return document.querySelector('.shuffleControl') ||
           document.querySelector('button.shuffleControl') ||
           document.querySelector('button[class*="shuffleControl"]') ||
           document.querySelector('.playControls__shuffle button') ||
           document.querySelector('button[title*="Shuffle"]') ||
           document.querySelector('button[title*="shuffle"]') ||
           document.querySelector('button[title*="Перемеш"]') ||
           document.querySelector('button[title*="перемеш"]') ||
           document.querySelector('button[aria-label*="Shuffle"]') ||
           document.querySelector('button[aria-label*="shuffle"]') ||
           document.querySelector('button[aria-label*="Перемеш"]') ||
           document.querySelector('button[aria-label*="перемеш"]') ||
           document.querySelector('button[data-testid*="shuffle"]');
  }

  function isSoundCloudShuffleActive(btn) {
    if (!btn) return false;
    const cls = typeof btn.className === 'string' ? btn.className : '';
    const title = (btn.getAttribute('title') || '').toLowerCase();
    const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
    const checked = btn.getAttribute('aria-checked');

    if (checked === 'true') return true;
    if (cls.includes('m-shuffling') || cls.includes('m-active') || cls.includes('active') || cls.includes('sc-button-selected') || cls.includes('selected')) return true;
    if (title.includes('on') || title.includes('включен') || aria.includes('on') || aria.includes('включен')) return true;
    return false;
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
      console.warn('[SC Bridge EQ] Error creating context EQ chain:', e);
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
      console.warn('[SC Bridge EQ] Init error:', e);
    }
  }

  // SoundCloud's player calls createMediaElementSource() on its own <audio> elements and routes
  // them to ctx.destination — the connect() hook above already puts our EQ into that graph.
  // An element can be sourced only once, so if we grabbed it first SoundCloud's call would throw
  // InvalidStateError and the player would skip every track. Remember what the page sourced itself.
  const pageSourcedElements = new WeakSet();
  let creatingOwnSource = false;
  if (window.AudioContext && AudioContext.prototype.createMediaElementSource) {
    const rawCreateMediaElementSource = AudioContext.prototype.createMediaElementSource;
    AudioContext.prototype.createMediaElementSource = function(mediaElement) {
      if (!creatingOwnSource && mediaElement) pageSourcedElements.add(mediaElement);
      return rawCreateMediaElementSource.apply(this, arguments);
    };
  }

  // Fallback for media the page does NOT route through Web Audio. Only called once the element
  // is actually playing, by which time SoundCloud has already built its own graph for it.
  function connectAudioToEq(audio) {
    if (!audio) return;
    if (eqConnectedElements.has(audio) || pageSourcedElements.has(audio)) return;

    try {
      initEq();
      if (!eqAudioCtx) return;
      const chain = createEqChainForContext(eqAudioCtx);
      if (!chain) return;
      creatingOwnSource = true;
      let sourceNode;
      try {
        sourceNode = eqAudioCtx.createMediaElementSource(audio);
      } finally {
        creatingOwnSource = false;
      }
      rawAudioNodeConnect.call(sourceNode, chain.firstFilter);
      eqConnectedElements.add(audio);
      if (eqAudioCtx.state === 'suspended') {
        eqAudioCtx.resume().catch(() => {});
      }
    } catch (e) {
      // Element might already be connected by internal player
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

  // SoundCloud keeps its <audio> elements detached from the DOM, so querySelectorAll alone
  // never sees them. Every element that passes through registerAudio is remembered here.
  const trackedMedia = new Set();

  function getAllMedia() {
    const set = new Set(trackedMedia);
    document.querySelectorAll('audio, video').forEach(el => set.add(el));
    return Array.from(set);
  }

  function findAllMediaElements() {
    const list = getAllMedia();
    document.querySelectorAll('iframe').forEach(frame => {
      try {
        if (frame.contentDocument) {
          list.push(...Array.from(frame.contentDocument.querySelectorAll('audio, video')));
        }
      } catch (e) {}
    });
    return list;
  }

  function registerAudio(audio) {
    if (!audio) return;
    trackedMedia.add(audio);

    if (typeof window._currentVolume === 'number') {
      try { audio.volume = window._currentVolume; } catch (e) {}
    }

    if (!audio._mhTracked) {
      audio._mhTracked = true;

      audio.addEventListener('play', () => {
        activeAudioEl = audio;
        lastState = true;
        if (typeof window._currentVolume === 'number') {
          try { audio.volume = window._currentVolume; } catch (e) {}
        }
        if (eqAudioCtx && eqAudioCtx.state === 'suspended') {
          eqAudioCtx.resume().catch(() => {});
        }
        emit('state', { isPlaying: true });
        extractAndEmitTrack();
      });

      audio.addEventListener('playing', () => {
        connectAudioToEq(audio);
      });

      audio.addEventListener('pause', () => {
        const anyPlaying = getAllMedia().some(a => !a.paused && a.currentTime > 0);
        if (!anyPlaying) {
          lastState = false;
          emit('state', { isPlaying: false });
        }
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
        registerAudio(el);
      }
    }
    return el;
  };

  // Intercept HTMLMediaElement.prototype.play
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function() {
    try {
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
  // When attached from the webview preload the document may not have a root element yet
  function startObserver() {
    if (document.documentElement) {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } else {
      document.addEventListener('readystatechange', startObserver, { once: true });
    }
  }
  startObserver();

  function extractAndEmitTrack() {
    let title = '';
    let artist = '';
    let cover = null;
    let duration = 0;

    // 1. From navigator.mediaSession
    if (navigator.mediaSession && navigator.mediaSession.metadata) {
      const meta = navigator.mediaSession.metadata;
      title = meta.title || '';
      artist = meta.artist || '';
      if (meta.artwork && meta.artwork.length > 0) {
        cover = meta.artwork[meta.artwork.length - 1].src;
      }
    }

    // 2. From DOM selectors
    const titleEl = document.querySelector('.playbackSoundBadge__titleLink');
    const artistEl = document.querySelector('.playbackSoundBadge__lightLink');
    const avatarEl = document.querySelector('.playbackSoundBadge__avatar .image__full') ||
                     document.querySelector('.playbackSoundBadge__avatar span');
    const totalTimeEl = document.querySelector('.playbackTimeline__duration span:last-child');

    if (!title && titleEl) title = titleEl.title || titleEl.textContent.trim();
    if (!artist && artistEl) artist = artistEl.title || artistEl.textContent.trim();

    if (!cover && avatarEl) {
      const bg = avatarEl.style.backgroundImage;
      if (bg) {
        const match = bg.match(/url\(["']?([^"']*)["']?\)/);
        if (match) cover = match[1];
      }
    }

    if (activeAudioEl && !isNaN(activeAudioEl.duration) && activeAudioEl.duration > 0) {
      duration = Math.round(activeAudioEl.duration);
    } else if (totalTimeEl) {
      duration = parseTime(totalTimeEl.textContent);
    }

    let permalink = '';
    if (titleEl && titleEl.href) {
      permalink = titleEl.href;
    } else if (window.location && window.location.href && !window.location.href.includes('/discover') && !window.location.href.includes('/feed')) {
      permalink = window.location.href;
    }

    const artistUrl = (artistEl && artistEl.href) ? artistEl.href.split('?')[0] : '';

    if (title && title !== lastTitle) {
      lastTitle = title;
      emit('track', {
        title,
        artist,
        cover,
        duration,
        permalink,
        artistUrl
      });
    }
  }

  function getSoundCloudRepeatMode() {
    const btn = document.querySelector('.repeatControl') ||
                document.querySelector('button[title*="Repeat"]') ||
                document.querySelector('button[title*="повтор"]') ||
                document.querySelector('button[aria-label*="Repeat"]') ||
                document.querySelector('button[aria-label*="повтор"]');
    if (!btn) return 'none';
    if (btn.classList.contains('m-one') || btn.classList.contains('repeat-one')) return 'one';
    if (btn.classList.contains('m-all') || btn.classList.contains('m-active') || btn.classList.contains('active')) return 'all';
    return 'none';
  }

  function checkState() {
    scanAudios();

    // Check playback state from audio or DOM
    let isPlaying = false;
    const playingAudio = getAllMedia().find(a => !a.paused && a.currentTime > 0);
    if (playingAudio) {
      activeAudioEl = playingAudio;
      isPlaying = true;
    } else if (activeAudioEl && !activeAudioEl.paused) {
      isPlaying = true;
    } else {
      const playBtn = getSoundCloudPlayButton();
      if (playBtn) {
        isPlaying = playBtn.classList.contains('playing') ||
                    (playBtn.getAttribute('title') || '').toLowerCase().includes('pause') ||
                    (playBtn.getAttribute('aria-label') || '').toLowerCase().includes('pause');
      }
    }

    if (isPlaying !== lastState) {
      lastState = isPlaying;
      emit('state', { isPlaying });
    }

    extractAndEmitTrack();

    // Check repeat mode state from DOM
    const currentRepeat = getSoundCloudRepeatMode();
    if (currentRepeat && currentRepeat !== lastRepeatMode) {
      lastRepeatMode = currentRepeat;
      window._repeatMode = currentRepeat;
      if (activeAudioEl) {
        activeAudioEl.loop = (currentRepeat === 'one');
      }
      emit('repeat', { mode: currentRepeat });
    }

    // Check shuffle state from DOM
    const shuffleBtn = getSoundCloudShuffleButton();
    if (shuffleBtn) {
      const isShuffled = isSoundCloudShuffleActive(shuffleBtn);
      if (lastShuffleState !== isShuffled) {
        lastShuffleState = isShuffled;
        emit('shuffle', { isShuffle: isShuffled });
      }
    }

    // Progress fallback from DOM if audio element timeupdate is delayed
    if (isPlaying && (!activeAudioEl || isNaN(activeAudioEl.duration) || activeAudioEl.duration === 0)) {
      const curTimeEl = document.querySelector('.playbackTimeline__timePassed span:last-child');
      const totalTimeEl = document.querySelector('.playbackTimeline__duration span:last-child');
      if (curTimeEl && totalTimeEl) {
        emit('progress', {
          position: parseTime(curTimeEl.textContent),
          duration: parseTime(totalTimeEl.textContent)
        });
      }
    }

    // Ensure all audio elements have current volume applied
    if (typeof window._currentVolume === 'number') {
      getAllMedia().forEach(el => {
        if (Math.abs(el.volume - window._currentVolume) > 0.05) {
          try {
            el.volume = window._currentVolume;
            if (window._currentVolume > 0 && el.muted) el.muted = false;
          } catch(e) {}
        }
      });
    }
  }

  // ---- Like of the current track (heart in the app's player bar) ----
  function findLikeButton() {
    return document.querySelector('.playbackSoundBadge__like');
  }

  function getLikeState() {
    const btn = findLikeButton();
    if (!btn) return null;
    return btn.classList.contains('sc-button-selected') || /^unlike/i.test(btn.title || btn.getAttribute('aria-label') || '');
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
    // SoundCloud flips the class right away; give it a moment and report what it shows
    return new Promise(resolve => setTimeout(() => { checkLike(); resolve(getLikeState()); }, 350));
  }

  setInterval(checkState, 400);
  setInterval(checkLike, 700);

  // ---- "Next up" queue ------------------------------------------------------
  // SoundCloud renders its queue panel only while it is open, as a virtual list (56px rows,
  // only the visible part in the DOM). To read it we open the panel invisibly, scroll it
  // through, and close it again if it was closed before.
  const QUEUE_ROW_HEIGHT = 56;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let queueBusy = Promise.resolve();

  function withQueuePanel(task) {
    const run = async () => {
      const panel = document.querySelector('.queue');
      const toggle = document.querySelector('a.playbackSoundBadge__showQueue');
      if (!panel || !toggle) return null;
      const wasOpen = panel.classList.contains('m-visible');
      let style = null;
      if (!wasOpen) {
        style = document.createElement('style');
        style.textContent = '.playControls__queue { visibility: hidden !important; pointer-events: none !important; }';
        document.documentElement.appendChild(style);
        toggle.click();
        for (let i = 0; i < 20 && !panel.classList.contains('m-visible'); i++) await sleep(50);
        await sleep(250);
      }
      try {
        return await task();
      } finally {
        if (!wasOpen) {
          const hide = document.querySelector('.queue__hide');
          if (hide) hide.click(); else toggle.click();
          setTimeout(() => style && style.remove(), 600);
        }
      }
    };
    const next = queueBusy.then(run, run);
    queueBusy = next.catch(() => {});
    return next;
  }

  // Row index from the real layout position inside the full-height list (transforms of the
  // container and rows are updated at different moments while scrolling, rects are always consistent)
  function renderedQueueRows() {
    const list = document.querySelector('.queue__itemsHeight');
    if (!list) return [];
    const top = list.getBoundingClientRect().top;
    return Array.from(document.querySelectorAll('.queue__itemWrapper')).map(w => {
      const view = w.querySelector('.queueItemView');
      if (!view) return null;
      return { index: Math.round((w.getBoundingClientRect().top - top) / QUEUE_ROW_HEIGHT), view };
    }).filter(r => r && r.index >= 0);
  }

  function readQueueRow(index, view) {
    const titleLink = view.querySelector('.queueItemView__title a, a.sc-link-dark');
    const user = view.querySelector('.queueItemView__username');
    const art = view.querySelector('.queueItemView__artwork span[style*="background-image"]');
    const artUrl = art ? ((art.style.backgroundImage.match(/url\("?(.*?)"?\)/) || [])[1] || null) : null;
    const href = titleLink ? titleLink.getAttribute('href') : '';
    return {
      key: index,
      state: view.classList.contains('m-active') ? 'current'
        : view.classList.contains('m-upcoming') ? 'upcoming' : 'played',
      title: titleLink ? titleLink.textContent.trim() : '',
      artist: user ? user.textContent.trim() : '',
      cover: artUrl ? artUrl.replace(/-t\d+x\d+\./, '-t200x200.') : null,
      duration: parseTime((view.querySelector('.queueItemView__duration') || {}).textContent || ''),
      permalink: href ? new URL(href, location.origin).href.split('?')[0] : '',
      context: ((view.querySelector('.queueItemView__context') || {}).textContent || '').trim(),
      removable: !!view.querySelector('.removeFromNextUp')
    };
  }

  async function scrollQueueTo(index) {
    const inner = document.querySelector('.queue__scrollableInner');
    if (!inner) return;
    inner.scrollTop = Math.max(0, index * QUEUE_ROW_HEIGHT - QUEUE_ROW_HEIGHT);
    inner.dispatchEvent(new Event('scroll'));
    await sleep(120);
  }

  async function findQueueRow(index) {
    let row = renderedQueueRows().find(r => r.index === index);
    if (!row) {
      await scrollQueueTo(index);
      row = renderedQueueRows().find(r => r.index === index);
    }
    return row || null;
  }

  function getQueue() {
    return withQueuePanel(async () => {
      const inner = document.querySelector('.queue__scrollableInner');
      if (!inner) return null;
      const items = new Map();
      const collect = () => renderedQueueRows().forEach(r => items.set(r.index, readQueueRow(r.index, r.view)));
      const saved = inner.scrollTop;
      // The virtual list renders the viewport plus a buffer, so one viewport per step is enough
      const step = Math.max(QUEUE_ROW_HEIGHT, inner.clientHeight - QUEUE_ROW_HEIGHT);
      for (let top = 0; top <= inner.scrollHeight; top += step) {
        inner.scrollTop = top;
        inner.dispatchEvent(new Event('scroll'));
        await sleep(40);
        collect();
      }
      inner.scrollTop = saved;
      inner.dispatchEvent(new Event('scroll'));

      const list = Array.from(items.values()).sort((a, b) => a.key - b.key);
      const currentPos = list.findIndex(i => i.state === 'current');
      const current = currentPos >= 0 ? list[currentPos] : null;
      // "Previously played" = played tracks right before the current one from the same source
      // (the same playlist/album/"Added by you"); SoundCloud also keeps the whole listening history here
      const history = [];
      if (current) {
        for (let i = currentPos - 1; i >= 0; i--) {
          const item = list[i];
          if (item.state !== 'played' || item.context !== current.context) break;
          history.unshift(item);
        }
      }
      return {
        context: current ? current.context : '',
        history,
        current,
        upcoming: list.filter((i, pos) => i.state === 'upcoming' && pos > currentPos)
      };
    });
  }

  function playQueueItem(index) {
    return withQueuePanel(async () => {
      const row = await findQueueRow(Number(index));
      if (!row) return false;
      const btn = row.view.querySelector('.queueItemView__playButton .sc-button-play:not(.sc-button-pause)')
        || row.view.querySelector('.queueItemView__playButton .sc-button-play');
      if (!btn) return false;
      triggerClick(btn);
      await sleep(300);
      return true;
    });
  }

  function removeQueueItem(index) {
    return withQueuePanel(async () => {
      const row = await findQueueRow(Number(index));
      const btn = row && row.view.querySelector('.removeFromNextUp');
      if (!btn) return false;
      triggerClick(btn);
      await sleep(300);
      return true;
    });
  }

  // Open a soundcloud.com page inside the SPA so the current playback is not interrupted
  function navigateInApp(url) {
    let target;
    try { target = new URL(url, window.location.origin); } catch (e) { return; }
    if (target.origin !== window.location.origin) {
      window.location.assign(target.href);
      return;
    }
    if (window.location.pathname === target.pathname && window.location.search === target.search) return;

    // SoundCloud's router intercepts clicks on its own links (e.g. the player badge links)
    const link = Array.from(document.querySelectorAll('a[href]')).find(a => {
      try {
        const u = new URL(a.href, window.location.origin);
        return u.pathname === target.pathname && u.search === target.search;
      } catch (e) { return false; }
    });
    if (link) {
      triggerClick(link);
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

  // Commands
  window.musicHubBridge = {
    play: function() {
      if (mediaSessionHandlers['play']) {
        try { mediaSessionHandlers['play']({ action: 'play' }); return; } catch(e) {}
      }
      if (activeAudioEl && activeAudioEl.paused) {
        try { activeAudioEl.play().catch(() => {}); return; } catch(e) {}
      }
      const playBtn = getSoundCloudPlayButton();
      if (playBtn && !playBtn.classList.contains('playing')) {
        triggerClick(playBtn);
        return;
      }
      try {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true }));
      } catch (e) {}
    },

    pause: function() {
      if (mediaSessionHandlers['pause']) {
        try { mediaSessionHandlers['pause']({ action: 'pause' }); } catch(e) {}
      }
      if (activeAudioEl && !activeAudioEl.paused) {
        try { activeAudioEl.pause(); } catch(e) {}
      }
      const playBtn = getSoundCloudPlayButton();
      if (playBtn && (playBtn.classList.contains('playing') || (playBtn.getAttribute('title') || '').toLowerCase().includes('pause') || (playBtn.getAttribute('aria-label') || '').toLowerCase().includes('pause'))) {
        triggerClick(playBtn);
      }
      getAllMedia().forEach(el => { try { el.pause(); } catch(e){} });
      lastState = false;
      emit('state', { isPlaying: false });
    },

    toggle: function() {
      let isPlaying = false;
      const playingAudio = getAllMedia().find(a => !a.paused && a.currentTime > 0);
      if (playingAudio) {
        isPlaying = true;
      } else if (activeAudioEl && !activeAudioEl.paused) {
        isPlaying = true;
      } else {
        const playBtn = getSoundCloudPlayButton();
        if (playBtn) {
          isPlaying = playBtn.classList.contains('playing') ||
                      (playBtn.getAttribute('title') || '').toLowerCase().includes('pause') ||
                      (playBtn.getAttribute('aria-label') || '').toLowerCase().includes('pause');
        }
      }

      if (isPlaying) {
        this.pause();
      } else {
        this.play();
      }
    },

    next: function() {
      if (mediaSessionHandlers['nexttrack']) {
        try { mediaSessionHandlers['nexttrack']({ action: 'nexttrack' }); return; } catch(e) {}
      }
      const btn = document.querySelector('.skipControl__next') ||
                  document.querySelector('button[title*="Next"]') ||
                  document.querySelector('button[aria-label*="Next"]') ||
                  document.querySelector('button[title*="следующ"]') ||
                  document.querySelector('button[aria-label*="следующ"]');
      if (btn) triggerClick(btn);
    },

    prev: function() {
      if (mediaSessionHandlers['previoustrack']) {
        try { mediaSessionHandlers['previoustrack']({ action: 'previoustrack' }); return; } catch(e) {}
      }
      const btn = document.querySelector('.skipControl__previous') ||
                  document.querySelector('button[title*="Previous"]') ||
                  document.querySelector('button[aria-label*="Previous"]') ||
                  document.querySelector('button[title*="предыдущ"]') ||
                  document.querySelector('button[aria-label*="предыдущ"]');
      if (btn) triggerClick(btn);
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

      // 2. Dispatch accurate click event sequence to SoundCloud progress bar
      const progressWrapper = document.querySelector('.playbackTimeline__progressWrapper') ||
                              document.querySelector('.playbackTimeline__progressBar') ||
                              document.querySelector('.playbackTimeline');
      if (progressWrapper) {
        const rect = progressWrapper.getBoundingClientRect();
        const clientX = rect.left + (clamped / 100) * rect.width;
        const clientY = rect.top + rect.height / 2;

        const eventOpts = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX,
          clientY,
          pageX: clientX,
          pageY: clientY,
          button: 0,
          buttons: 1
        };

        progressWrapper.dispatchEvent(new MouseEvent('mousedown', eventOpts));
        progressWrapper.dispatchEvent(new MouseEvent('mouseup', eventOpts));
        progressWrapper.dispatchEvent(new MouseEvent('click', eventOpts));
      }
    },

    setVolume: function(val) {
      const clamped = Math.max(0, Math.min(1, val));
      window._currentVolume = clamped;

      getAllMedia().forEach(el => {
        try {
          el.volume = clamped;
          if (clamped > 0 && el.muted) el.muted = false;
        } catch (e) {}
      });
      if (activeAudioEl) {
        try {
          activeAudioEl.volume = clamped;
          if (clamped > 0 && activeAudioEl.muted) activeAudioEl.muted = false;
        } catch (e) {}
      }
    },

    setShuffle: function(enable) {
      const btn = getSoundCloudShuffleButton();
      if (btn) {
        const isShuffling = isSoundCloudShuffleActive(btn);
        if (Boolean(enable) !== isShuffling) {
          triggerClick(btn);
        }
      }
    },

    setRepeat: function(mode) {
      window._repeatMode = mode;
      lastRepeatMode = mode;

      getAllMedia().forEach(el => {
        el.loop = (mode === 'one');
      });
      if (activeAudioEl) {
        activeAudioEl.loop = (mode === 'one');
      }

      const btn = document.querySelector('.repeatControl') ||
                  document.querySelector('button[title*="Repeat"]') ||
                  document.querySelector('button[title*="повтор"]') ||
                  document.querySelector('button[aria-label*="Repeat"]') ||
                  document.querySelector('button[aria-label*="повтор"]');
      if (btn) {
        const current = getSoundCloudRepeatMode();
        if (current === mode) return;

        let neededClicks = 1;
        if ((current === 'none' && mode === 'one') ||
            (current === 'all' && mode === 'none') ||
            (current === 'one' && mode === 'all')) {
          neededClicks = 2;
        }

        triggerClick(btn);
        if (neededClicks === 2) {
          setTimeout(() => {
            const now = getSoundCloudRepeatMode();
            if (now !== mode && btn) {
              triggerClick(btn);
            }
          }, 150);
        }
      }
    },

    toggleRepeat: function() {
      const current = getSoundCloudRepeatMode();
      let nextMode = 'none';
      if (current === 'none') nextMode = 'all';
      else if (current === 'all') nextMode = 'one';
      else nextMode = 'none';
      this.setRepeat(nextMode);
    },

    setEqualizer: function(config) {
      if (!config) return;
      eqConfig.enabled = config.enabled !== false;
      if (Array.isArray(config.gains)) {
        eqConfig.gains = config.gains;
      }
      applyEqGains();
      // Only hook media that is already playing — see connectAudioToEq for why
      findAllMediaElements().forEach(el => {
        if (!el.paused && el.currentTime > 0) connectAudioToEq(el);
      });
    },

    navigateTo: function(url) {
      navigateInApp(url);
    },

    getQueue: getQueue,
    playQueueItem: playQueueItem,
    removeQueueItem: removeQueueItem,
    setVisualizer: setVisualizer,
    getLike: getLikeState,
    toggleLike: toggleLike,

    getCurrentTrack: function() {
      const titleEl = document.querySelector('.playbackSoundBadge__titleLink');
      const artistEl = document.querySelector('.playbackSoundBadge__lightLink');
      const avatarEl = document.querySelector('.playbackSoundBadge__avatar .image__full') ||
                       document.querySelector('.playbackSoundBadge__avatar span');
      let cover = null;
      if (avatarEl) {
        const bg = avatarEl.style.backgroundImage;
        if (bg) {
          const match = bg.match(/url\(["']?([^"']*)["']?\)/);
          if (match) cover = match[1];
        }
      }
      return {
        title: titleEl ? (titleEl.title || titleEl.textContent.trim()) : lastTitle,
        artist: artistEl ? (artistEl.title || artistEl.textContent.trim()) : '',
        cover: cover,
        permalink: titleEl ? titleEl.href : window.location.href
      };
    }
  };

  console.log('SoundCloud Bridge successfully attached and ready');
})();
