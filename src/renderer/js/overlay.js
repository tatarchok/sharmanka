(function () {
  const titleEl = document.getElementById('overlay-title');
  const artistEl = document.getElementById('overlay-artist');
  const artImg = document.getElementById('overlay-art-img');
  const artPlaceholder = document.getElementById('overlay-art-placeholder');
  const playBtn = document.getElementById('overlay-play');
  const prevBtn = document.getElementById('overlay-prev');
  const nextBtn = document.getElementById('overlay-next');

  const PLAY_ICON = '<path d="M320-200v-560l440 280-440 280Z"/>';
  const PAUSE_ICON = '<path d="M560-200v-560h160v560H560Zm-320 0v-560h160v560H240Z"/>';

  function render(data) {
    if (!data) return;

    titleEl.textContent = data.title || 'Sharmanka';
    artistEl.textContent = data.artist || 'Ничего не играет';

    if (data.cover) {
      artImg.src = data.cover;
      artImg.style.display = 'block';
      artPlaceholder.style.display = 'none';
    } else {
      artImg.removeAttribute('src');
      artImg.style.display = 'none';
      artPlaceholder.style.display = 'flex';
    }

    playBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 -960 960 960" width="16px" fill="currentColor">${data.isPlaying ? PAUSE_ICON : PLAY_ICON}</svg>`;
  }

  window.overlayApi.onTrackData(render);

  playBtn.addEventListener('click', () => window.overlayApi.sendControl('toggle'));
  prevBtn.addEventListener('click', () => window.overlayApi.sendControl('prev'));
  nextBtn.addEventListener('click', () => window.overlayApi.sendControl('next'));

  // Cover, title and artist bring the main window back
  for (const el of [document.getElementById('overlay-art-wrap'), titleEl, artistEl]) {
    el.classList.add('overlay-restore');
    el.title = 'Развернуть Sharmanka';
    el.addEventListener('click', () => window.overlayApi.restoreMain());
  }
})();
