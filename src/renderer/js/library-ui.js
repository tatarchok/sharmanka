/* ==========================================================================
   Media Library UI Handler (Tracks, Albums, Playlists, Album Editor & Context Menu)
   ========================================================================== */

class LibraryUI {
  constructor() {
    this.tracks = [];
    this.albums = [];
    this.playlists = [];
    this.currentSubnav = 'tracks'; // 'tracks' | 'albums' | 'playlists' | 'album-details' | 'playlist-details'
    this.currentFilter = 'all'; // 'all' | 'local' | 'liked'
    this.searchQuery = '';
    this.albumSearchQuery = '';
    this.albumSortMode = 'default';
    this.selectedAlbum = null;
    this.selectedPlaylist = null;
    this.contextTargetTrack = null;

    // Album edit state
    this.editingAlbum = null;
    this.editingCustomCoverPath = null;
    this.isCoverRemoved = false;

    // Track edit state
    this.editingTrack = null;
    this.editingTrackCustomCoverPath = null;
    this.isTrackCoverRemoved = false;

    this.init();
  }

  async init() {
    this.bindEvents();
    this.bindAlbumEvents();
    this.bindEditAlbumModal();
    this.bindEditTrackModal();
    this.bindContextMenu();
    this.bindPlaylistModal();
    await this.refreshAllData();
  }

  async refreshAllData() {
    await this.loadTracks();
    await this.loadAlbums();
    await this.loadPlaylists();
  }

  bindEvents() {
    // Sub-navigation buttons (Tracks, Albums, Playlists)
    document.querySelectorAll('.subnav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const sub = btn.dataset.sub;
        if (sub) this.switchSubnav(sub);
      });
    });

    // Back to Albums button
    document.getElementById('btn-back-to-albums')?.addEventListener('click', () => {
      this.switchSubnav('albums');
    });

    // Back to Playlists button
    document.getElementById('btn-back-to-playlists')?.addEventListener('click', () => {
      this.switchSubnav('playlists');
    });

    // Tracks search input
    const searchInput = document.getElementById('library-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.searchQuery = e.target.value.toLowerCase().trim();
        this.renderTracks();
      });
    }

    // "Вперемешку": shuffle the tracks currently shown (respects filter and search)
    document.getElementById('btn-library-shuffle')?.addEventListener('click', (e) => {
      e.stopPropagation(); // keep the queue drawer that opens next from closing right away
      const tracks = this.getFilteredTracks();
      if (!tracks.length) {
        window.appController?.showToast('Нет треков для воспроизведения', 'info');
        return;
      }
      window.localPlayer.playShuffled(tracks);
    });

    // Filter pills
    document.querySelectorAll('.filter-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        this.currentFilter = pill.dataset.filter || 'all';
        this.renderTracks();
      });
    });

    // Header & Empty state folder button
    const onChooseFolder = async () => {
      const curPath = window.appController?.config?.library?.musicFolder || '';
      const selected = await window.api.library.selectDirectory(curPath);
      if (selected && window.appController) {
        if (!window.appController.config.library) window.appController.config.library = {};
        window.appController.config.library.musicFolder = selected;
        window.appController.config.library.folders = [selected];
        await window.api.library.saveConfig(window.appController.config);
        window.appController.populateSettingsUI();
        this.scanLibrary();
      }
    };

    document.getElementById('btn-header-add-folder')?.addEventListener('click', onChooseFolder);
    document.getElementById('btn-empty-add-folder')?.addEventListener('click', onChooseFolder);

    // Scan progress listener
    window.api.library.onScanProgress((data) => {
      const statusEl = document.getElementById('library-scan-status');
      if (statusEl) {
        statusEl.textContent = `Сканирование: ${data.processed}/${data.total} (${data.currentFile})`;
      }
    });

    // Online cover search progress (runs in the background after a scan)
    window.api.library.onCoversProgress?.((data) => {
      const statusEl = document.getElementById('library-scan-status');
      if (!statusEl || !data) return;
      if (data.finished) {
        statusEl.textContent = data.found ? `Найдено обложек в интернете: ${data.found}` : '';
        if (data.found) setTimeout(() => { if (statusEl.textContent.startsWith('Найдено обложек')) statusEl.textContent = ''; }, 5000);
      } else if (data.total) {
        statusEl.textContent = `Поиск обложек: ${data.done}/${data.total} (найдено ${data.found})`;
      }
    });

    // Library changed in the main process (covers found, download finished)
    window.api.library.onUpdated?.(() => this.reloadData());

    // Play entire Album button
    document.getElementById('btn-play-current-album')?.addEventListener('click', () => {
      if (this.selectedAlbum && this.selectedAlbum.tracks.length > 0) {
        window.localPlayer.setQueue(this.selectedAlbum.tracks, 0);
      }
    });

    // Play entire Playlist button
    document.getElementById('btn-play-current-playlist')?.addEventListener('click', () => {
      if (this.selectedPlaylist && this.selectedPlaylist.tracks.length > 0) {
        window.localPlayer.setQueue(this.selectedPlaylist.tracks, 0);
      }
    });
  }

  bindAlbumEvents() {
    // Albums search input
    const albumsSearchInput = document.getElementById('albums-search-input');
    if (albumsSearchInput) {
      albumsSearchInput.addEventListener('input', (e) => {
        this.albumSearchQuery = e.target.value.toLowerCase().trim();
        this.renderAlbums();
      });
    }

    // Album sort pills
    const sortPills = document.querySelectorAll('#albums-sort-pills .filter-pill');
    sortPills.forEach(pill => {
      pill.addEventListener('click', () => {
        sortPills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        this.albumSortMode = pill.dataset.sort || 'default';
        this.renderAlbums();
      });
    });

    // Album details actions
    document.getElementById('btn-edit-current-album')?.addEventListener('click', () => {
      if (this.selectedAlbum) this.openEditAlbumModal(this.selectedAlbum);
    });

    document.getElementById('btn-open-album-folder')?.addEventListener('click', () => {
      if (this.selectedAlbum) {
        const targetPath = this.selectedAlbum.folderPath || this.selectedAlbum.tracks[0]?.filePath;
        if (targetPath) {
          window.api.app.showItemInFolder(targetPath);
        }
      }
    });

    document.getElementById('btn-delete-current-album')?.addEventListener('click', async () => {
      if (!this.selectedAlbum) return;
      const album = this.selectedAlbum;
      const confirmed = confirm(`Удалить альбом «${album.title}»?\nПапка альбома со всеми аудиофайлами будет полностью удалена с диска.`);
      if (!confirmed) return;

      try {
        await window.api.library.deleteAlbum(album.id, true);
        window.appController?.showToast(`Альбом «${album.title}» удалён с диска`, 'info');
        await this.loadAlbums();
        await this.loadTracks();
        this.switchSubnav('albums');
      } catch (err) {
        console.error('Failed to delete album:', err);
        window.appController?.showToast(`Ошибка удаления альбома: ${err.message || err}`, 'error');
      }
    });
  }

  // ==========================================
  // Edit Album Modal Handler
  // ==========================================
  bindEditAlbumModal() {
    const modal = document.getElementById('edit-album-modal');
    const closeBtn = document.getElementById('btn-close-edit-album-modal');
    const cancelBtn = document.getElementById('btn-cancel-edit-album');
    const saveBtn = document.getElementById('btn-save-edit-album');
    const chooseCoverBtn = document.getElementById('btn-edit-choose-cover');
    const removeCoverBtn = document.getElementById('btn-edit-remove-cover');

    const closeModal = () => {
      if (modal) modal.classList.remove('active');
      this.editingAlbum = null;
      this.editingCustomCoverPath = null;
      this.isCoverRemoved = false;
    };

    closeBtn?.addEventListener('click', closeModal);
    cancelBtn?.addEventListener('click', closeModal);

    // Choose cover from PC
    chooseCoverBtn?.addEventListener('click', async () => {
      const selectedImg = await window.api.library.selectImage();
      if (selectedImg) {
        this.editingCustomCoverPath = selectedImg;
        this.isCoverRemoved = false;
        this.updateEditCoverPreview('file:///' + selectedImg.replace(/\\/g, '/'));
      }
    });

    // Remove cover
    removeCoverBtn?.addEventListener('click', () => {
      this.editingCustomCoverPath = null;
      this.isCoverRemoved = true;
      this.updateEditCoverPreview(null);
    });

    // Save album changes
    saveBtn?.addEventListener('click', async () => {
      if (!this.editingAlbum) return;

      const titleInput = document.getElementById('edit-album-title');
      const artistInput = document.getElementById('edit-album-artist');
      const yearInput = document.getElementById('edit-album-year');

      const title = titleInput?.value.trim() || this.editingAlbum.title;
      const artist = artistInput?.value.trim() || this.editingAlbum.artist;
      const year = yearInput?.value.trim() || null;

      const payload = {
        id: this.editingAlbum.id,
        title,
        artist,
        year
      };

      if (this.isCoverRemoved) {
        payload.coverArt = null;
      } else if (this.editingCustomCoverPath) {
        payload.customCoverPath = this.editingCustomCoverPath;
      }

      saveBtn.disabled = true;
      saveBtn.textContent = 'Сохранение...';

      try {
        this.albums = await window.api.library.updateAlbum(payload);
        closeModal();
        this.renderAlbums();

        // Update active album details if open
        const updatedAlbum = this.albums.find(a => a.id === payload.id);
        if (updatedAlbum) {
          this.selectedAlbum = updatedAlbum;
          if (this.currentSubnav === 'album-details') {
            this.openAlbumDetails(updatedAlbum);
          }
        }
      } catch (err) {
        alert('Ошибка при сохранении альбома: ' + err.message);
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Сохранить изменения';
      }
    });
  }

  openEditAlbumModal(album) {
    this.editingAlbum = album;
    this.editingCustomCoverPath = null;
    this.isCoverRemoved = false;

    const modal = document.getElementById('edit-album-modal');
    const titleInput = document.getElementById('edit-album-title');
    const artistInput = document.getElementById('edit-album-artist');
    const yearInput = document.getElementById('edit-album-year');

    if (titleInput) titleInput.value = album.title || '';
    if (artistInput) artistInput.value = album.artist || '';
    if (yearInput) yearInput.value = album.year || '';

    this.updateEditCoverPreview(album.coverArt);

    if (modal) modal.classList.add('active');
  }

  updateEditCoverPreview(coverUrl) {
    const previewImg = document.getElementById('edit-album-cover-preview');
    const placeholder = document.getElementById('edit-album-cover-placeholder');

    if (coverUrl) {
      if (previewImg) {
        previewImg.src = coverUrl;
        previewImg.style.display = 'block';
      }
      if (placeholder) placeholder.style.display = 'none';
    } else {
      if (previewImg) {
        previewImg.src = '';
        previewImg.style.display = 'none';
      }
      if (placeholder) placeholder.style.display = 'flex';
    }
  }

  // ==========================================
  // Edit Track Modal Handler
  // ==========================================
  bindEditTrackModal() {
    const modal = document.getElementById('edit-track-modal');
    const closeBtn = document.getElementById('btn-close-edit-track-modal');
    const cancelBtn = document.getElementById('btn-cancel-edit-track');
    const saveBtn = document.getElementById('btn-save-edit-track');
    const chooseCoverBtn = document.getElementById('btn-edit-track-choose-cover');
    const removeCoverBtn = document.getElementById('btn-edit-track-remove-cover');

    const closeModal = () => {
      if (modal) modal.classList.remove('active');
      this.editingTrack = null;
      this.editingTrackCustomCoverPath = null;
      this.isTrackCoverRemoved = false;
    };

    closeBtn?.addEventListener('click', closeModal);
    cancelBtn?.addEventListener('click', closeModal);

    // Choose cover from PC
    chooseCoverBtn?.addEventListener('click', async () => {
      const selectedImg = await window.api.library.selectImage();
      if (selectedImg) {
        this.editingTrackCustomCoverPath = selectedImg;
        this.isTrackCoverRemoved = false;
        this.updateEditTrackCoverPreview('file:///' + selectedImg.replace(/\\/g, '/'));
      }
    });

    // Remove cover
    removeCoverBtn?.addEventListener('click', () => {
      this.editingTrackCustomCoverPath = null;
      this.isTrackCoverRemoved = true;
      this.updateEditTrackCoverPreview(null);
    });

    // Save track changes
    saveBtn?.addEventListener('click', async () => {
      if (!this.editingTrack) return;

      const titleInput = document.getElementById('edit-track-title');
      const artistInput = document.getElementById('edit-track-artist');
      const albumInput = document.getElementById('edit-track-album');
      const yearInput = document.getElementById('edit-track-year');

      const title = titleInput?.value.trim() || this.editingTrack.title;
      const artist = artistInput?.value.trim() || this.editingTrack.artist;
      const album = albumInput?.value.trim() || '';
      const year = yearInput?.value.trim() || null;

      const payload = {
        id: this.editingTrack.id,
        title,
        artist,
        album,
        year,
        isCoverRemoved: this.isTrackCoverRemoved,
        customCoverPath: this.editingTrackCustomCoverPath
      };

      saveBtn.disabled = true;
      saveBtn.textContent = 'Сохранение...';

      try {
        const res = await window.api.library.updateTrack(payload);
        closeModal();

        if (res && res.success && res.track) {
          // Update track in memory
          const idx = this.tracks.findIndex(t => t.id === res.track.id);
          if (idx !== -1) {
            this.tracks[idx] = { ...this.tracks[idx], ...res.track };
          }

          // If current local player queue contains this track, update it
          if (window.localPlayer) {
            const curTrack = window.localPlayer.queue[window.localPlayer.currentIndex];
            if (curTrack && curTrack.id === res.track.id) {
              window.localPlayer.queue[window.localPlayer.currentIndex] = { ...curTrack, ...res.track };
              window.localPlayer.updateTrackDisplay(res.track);
            }
          }

          window.appController?.showToast(`Трек «${title}» успешно обновлён!`, 'success');
          await this.loadTracks();
          await this.loadAlbums();
          await this.loadPlaylists();
        }
      } catch (err) {
        console.error('Error saving track:', err);
        window.appController?.showToast(`Ошибка сохранения трека: ${err.message || err}`, 'error');
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Сохранить изменения';
      }
    });
  }

  openEditTrackModal(track) {
    if (!track) return;
    this.editingTrack = track;
    this.editingTrackCustomCoverPath = null;
    this.isTrackCoverRemoved = false;

    const modal = document.getElementById('edit-track-modal');
    const idInput = document.getElementById('edit-track-id');
    const titleInput = document.getElementById('edit-track-title');
    const artistInput = document.getElementById('edit-track-artist');
    const albumInput = document.getElementById('edit-track-album');
    const yearInput = document.getElementById('edit-track-year');

    if (idInput) idInput.value = track.id || '';
    if (titleInput) titleInput.value = track.title || '';
    if (artistInput) artistInput.value = (track.artist && track.artist !== 'Неизвестный исполнитель') ? track.artist : '';
    if (albumInput) albumInput.value = (track.album && track.album !== 'Неизвестный альбом' && track.album !== 'Без альбома') ? track.album : '';
    if (yearInput) yearInput.value = track.year || '';

    this.updateEditTrackCoverPreview(track.coverArt);

    if (modal) modal.classList.add('active');
  }

  updateEditTrackCoverPreview(coverUrl) {
    const previewImg = document.getElementById('edit-track-cover-preview');
    const placeholder = document.getElementById('edit-track-cover-placeholder');

    if (coverUrl) {
      if (previewImg) {
        previewImg.src = coverUrl;
        previewImg.style.display = 'block';
      }
      if (placeholder) placeholder.style.display = 'none';
    } else {
      if (previewImg) {
        previewImg.src = '';
        previewImg.style.display = 'none';
      }
      if (placeholder) placeholder.style.display = 'flex';
    }
  }

  async handleAddAlbumFolder() {
    try {
      const selected = await window.api.library.selectDirectory();
      if (!selected) return;

      const statusEl = document.getElementById('library-scan-status');
      if (statusEl) statusEl.textContent = 'Создание альбома из папки...';

      const result = await window.api.library.addAlbumFolder(selected);
      if (result && result.albums) {
        this.albums = result.albums;
        this.tracks = await window.api.library.getTracks();
        this.updateBadgeCount();
        this.renderAlbums();
        if (result.album) {
          this.openAlbumDetails(result.album);
        }
      }
      if (statusEl) statusEl.textContent = '';
    } catch (e) {
      alert('Ошибка при добавлении альбома: ' + (e.message || e));
      const statusEl = document.getElementById('library-scan-status');
      if (statusEl) statusEl.textContent = '';
    }
  }

  switchSubnav(subnavName) {
    // All subviews share one scroll container (.library-view): remember the list position when
    // opening album/playlist details, open details from the top, and restore the list on "back".
    const scroller = document.querySelector('#library-subview-albums')?.closest('.library-view');
    const isDetails = subnavName === 'album-details' || subnavName === 'playlist-details';
    const wasDetails = this.currentSubnav === 'album-details' || this.currentSubnav === 'playlist-details';
    if (scroller && isDetails && !wasDetails) {
      this.listScrollPositions = { ...(this.listScrollPositions || {}), [this.currentSubnav]: scroller.scrollTop };
    }

    this.currentSubnav = subnavName;

    // Update active subnav buttons
    document.querySelectorAll('.subnav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.sub === subnavName);
    });

    // Hide all subviews
    document.querySelectorAll('.library-subview').forEach(view => {
      view.classList.remove('active');
      view.style.display = 'none';
    });

    // Show target subview
    const targetView = document.getElementById(`library-subview-${subnavName}`);
    if (targetView) {
      targetView.classList.add('active');
      targetView.style.display = 'flex';
    }

    this.updateBadgeCount();

    // Re-render subview data
    if (subnavName === 'tracks') {
      this.renderTracks();
    } else if (subnavName === 'albums') {
      this.renderAlbums();
    } else if (subnavName === 'playlists') {
      this.renderPlaylists();
    }

    if (scroller) {
      if (isDetails) {
        scroller.scrollTop = 0;
      } else if (wasDetails) {
        scroller.scrollTop = this.listScrollPositions?.[subnavName] || 0;
      }
    }
  }

  async loadTracks() {
    try {
      this.tracks = await window.api.library.getTracks();
      this.updateBadgeCount();
      this.renderTracks();
      if (this.tracks.length === 0) {
        await this.scanLibrary();
      }
    } catch (e) {
      console.error('Failed to load tracks:', e);
    }
  }

  async loadAlbums() {
    try {
      this.albums = await window.api.library.getAlbums();
      this.updateBadgeCount();
      this.renderAlbums();
    } catch (e) {
      console.error('Failed to load albums:', e);
    }
  }

  async loadPlaylists() {
    try {
      this.playlists = await window.api.library.getPlaylists();
      this.updateBadgeCount();
      this.renderPlaylists();
    } catch (e) {
      console.error('Failed to load playlists:', e);
    }
  }

  async scanLibrary() {
    const statusEl = document.getElementById('library-scan-status');
    if (statusEl) statusEl.textContent = 'Сканирование папок...';

    try {
      const tracksRes = await window.api.library.scanFolders();
      this.tracks = Array.isArray(tracksRes) ? tracksRes : [];
      const albumsRes = await window.api.library.getAlbums();
      this.albums = Array.isArray(albumsRes) ? albumsRes : [];
      const playlistsRes = await window.api.library.getPlaylists();
      this.playlists = Array.isArray(playlistsRes) ? playlistsRes : [];
      this.updateBadgeCount();
      this.renderTracks();
      this.renderAlbums();
      this.renderPlaylists();
      if (statusEl) statusEl.textContent = '';
    } catch (e) {
      console.error('Scan error:', e);
      if (statusEl) statusEl.textContent = 'Ошибка сканирования';
    }
  }

  // Re-read tracks/albums/playlists without rescanning, keeping the current view and scroll
  async reloadData() {
    try {
      const scroller = document.querySelector('#library-subview-albums')?.closest('.library-view');
      const scrollTop = scroller ? scroller.scrollTop : 0;
      const [tracks, albums, playlists] = await Promise.all([
        window.api.library.getTracks(),
        window.api.library.getAlbums(),
        window.api.library.getPlaylists()
      ]);
      this.tracks = Array.isArray(tracks) ? tracks : [];
      this.albums = Array.isArray(albums) ? albums : [];
      this.playlists = Array.isArray(playlists) ? playlists : [];
      this.updateBadgeCount();
      this.renderTracks();
      this.renderAlbums();
      this.renderPlaylists();
      if (this.currentSubnav === 'album-details' && this.selectedAlbum) {
        const fresh = this.albums.find(a => a.id === this.selectedAlbum.id);
        if (fresh) {
          this.selectedAlbum = fresh;
          this.openAlbumDetails(fresh);
        }
      }
      if (scroller) scroller.scrollTop = scrollTop;
    } catch (e) {
      console.error('Library reload error:', e);
    }
  }

  async handleAddFolder() {
    try {
      const curPath = window.appController?.config?.library?.musicFolder || '';
      const selected = await window.api.library.selectDirectory(curPath);
      if (selected && window.appController) {
        if (!window.appController.config.library) window.appController.config.library = {};
        window.appController.config.library.musicFolder = selected;
        window.appController.config.library.folders = [selected];
        await window.api.library.saveConfig(window.appController.config);
        window.appController.populateSettingsUI();
        await this.scanLibrary();
      }
    } catch (e) {
      console.error('Error selecting music folder:', e);
    }
  }

  updateBadgeCount() {
    const badge = document.getElementById('library-badge-count');
    const subheader = document.getElementById('library-total-count');
    if (badge) badge.textContent = this.tracks.length;
    if (subheader) {
      if (this.currentSubnav === 'albums') {
        subheader.textContent = `${this.albums.length} альбомов • ${this.tracks.length} треков`;
      } else if (this.currentSubnav === 'playlists') {
        subheader.textContent = `${this.playlists.length} плейлистов • ${this.tracks.length} треков`;
      } else if (this.currentSubnav === 'album-details' && this.selectedAlbum) {
        subheader.textContent = `Альбом: ${this.selectedAlbum.title} • ${this.selectedAlbum.tracks?.length || 0} треков`;
      } else if (this.currentSubnav === 'playlist-details' && this.selectedPlaylist) {
        subheader.textContent = `Плейлист: ${this.selectedPlaylist.name} • ${this.selectedPlaylist.tracks?.length || 0} треков`;
      } else {
        subheader.textContent = `${this.tracks.length} треков • ${this.albums.length} альбомов`;
      }
    }
  }

  getFilteredTracks() {
    return this.tracks
      .filter(track => {
        if (this.currentFilter === 'local' && track.source !== 'local') return false;
        if (this.currentFilter === 'soundcloud' && track.source !== 'soundcloud') return false;
        if (this.currentFilter === 'liked' && !track.isLiked) return false;

        if (this.searchQuery) {
          const title = (track.title || '').toLowerCase();
          const artist = (track.artist || '').toLowerCase();
          const album = (track.album || '').toLowerCase();
          const filename = (track.filename || '').toLowerCase();
          return title.includes(this.searchQuery) ||
                 artist.includes(this.searchQuery) ||
                 album.includes(this.searchQuery) ||
                 filename.includes(this.searchQuery);
        }
        return true;
      })
      .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  }

  renderTracks() {
    const container = document.getElementById('library-tracks-tbody');
    const emptyState = document.getElementById('library-empty-state');
    const tableEl = document.getElementById('library-table-wrapper');
    if (!container) return;

    const filtered = this.getFilteredTracks();

    if (this.tracks.length === 0) {
      if (tableEl) tableEl.style.display = 'none';
      if (emptyState) emptyState.style.display = 'flex';
      return;
    } else {
      if (tableEl) tableEl.style.display = 'block';
      if (emptyState) emptyState.style.display = 'none';
    }

    container.innerHTML = '';

    if (filtered.length === 0) {
      container.innerHTML = `
        <tr>
          <td colspan="7" style="text-align: center; padding: 40px; color: var(--text-muted);">
            Треки не найдены по заданному фильтру
          </td>
        </tr>
      `;
      return;
    }

    filtered.forEach((track, index) => {
      const tr = this.createTrackTableRow(track, index + 1, filtered);
      container.appendChild(tr);
    });
  }

  formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  // "FLAC" for lossless files, "MP3 320" / "AAC 256" for lossy ones (format from the file extension)
  qualityBadgeHtml(track) {
    const name = track.filename || track.filePath || '';
    const ext = (name.match(/\.([a-z0-9]+)(?:$|\?)/i) || [])[1];
    if (!ext) return '<span class="track-quality quality-unknown">—</span>';
    const format = ext.toLowerCase();
    const LOSSLESS = { flac: 'FLAC', wav: 'WAV', aiff: 'AIFF', aif: 'AIFF', alac: 'ALAC' };
    if (LOSSLESS[format]) {
      return `<span class="track-quality quality-lossless" title="Без потерь (lossless)">${LOSSLESS[format]}</span>`;
    }

    const labels = { mp3: 'MP3', m4a: 'AAC', aac: 'AAC', ogg: 'OGG', opus: 'OPUS', wma: 'WMA' };
    const label = labels[format] || format.toUpperCase();
    let kbps = Math.round(Number(track.bitrate) || 0);
    if (!kbps) return `<span class="track-quality quality-unknown">${label}</span>`;
    // Snap near-standard values (VBR averages like 318 → 320)
    const STANDARD = [64, 96, 112, 128, 160, 192, 224, 256, 320];
    const near = STANDARD.find(s => Math.abs(s - kbps) / s <= 0.04);
    if (near) kbps = near;
    const tier = kbps >= 256 ? 'quality-high' : kbps >= 160 ? 'quality-mid' : 'quality-low';
    return `<span class="track-quality ${tier}" title="${label}, ${kbps} кбит/с">${label} ${kbps}</span>`;
  }

  createTrackTableRow(track, displayIndex, trackList) {
    const tr = document.createElement('tr');
    tr.className = 'track-row';
    tr.dataset.id = track.id;

    if (window.localPlayer?.queue[window.localPlayer?.currentIndex]?.id === track.id) {
      tr.classList.add('playing');
    }

    const durationStr = this.formatTime(track.duration);
    
    let sourceBadge = `<span class="track-source-badge source-local">Локально</span>`;
    if (track.source === 'soundcloud') {
      sourceBadge = `<span class="track-source-badge source-soundcloud">SoundCloud</span>`;
    } else if (track.source === 'yandex') {
      sourceBadge = `<span class="track-source-badge source-yandex">Яндекс Музыка</span>`;
    }

    const displayAlbum = (track.album && track.album !== 'Яндекс Музыка' && track.album !== 'SoundCloud' && track.album !== 'Неизвестный альбом' && track.album !== 'Без альбома')
      ? track.album
      : '—';

    const artHtml = track.coverArt 
      ? `<img class="track-art-thumb" src="${track.coverArt}" alt="art" />`
      : `<div class="track-art-thumb">
          <svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 -960 960 960" width="20px" fill="currentColor">
            <path d="M400-120q-66 0-113-47t-47-113q0-66 47-113t113-47q23 0 42.5 5.5T480-418v-422h240v160H560v400q0 66-47 113t-113 47Z"/>
          </svg>
        </div>`;

    tr.innerHTML = `
      <td class="track-num-col">
        <span class="track-num">${displayIndex}</span>
        <div class="track-wave-anim">
          <span class="wave-bar"></span>
          <span class="wave-bar"></span>
          <span class="wave-bar"></span>
          <span class="wave-bar"></span>
        </div>
        <div class="track-row-play-btn">
          <svg class="icon-play" xmlns="http://www.w3.org/2000/svg" height="18px" viewBox="0 -960 960 960" width="18px" fill="currentColor">
            <path d="M320-200v-560l440 280-440 280Z"/>
          </svg>
          <svg class="icon-pause" xmlns="http://www.w3.org/2000/svg" height="18px" viewBox="0 -960 960 960" width="18px" fill="currentColor">
            <path d="M560-200v-560h160v560H560Zm-320 0v-560h160v560H240Z"/>
          </svg>
        </div>
      </td>
      <td>
        <div class="track-title-col">
          ${artHtml}
          <div class="track-info-text">
            <span class="track-title" title="${track.title || track.filename}">${track.title || track.filename}</span>
            <span class="track-artist" title="${track.artist || ''}">${track.artist || 'Неизвестный исполнитель'}</span>
          </div>
        </div>
      </td>
      <td><span title="${displayAlbum !== '—' ? displayAlbum : ''}">${displayAlbum}</span></td>
      <td>${this.qualityBadgeHtml(track)}</td>
      <td>${sourceBadge}</td>
      <td>${durationStr}</td>
      <td class="track-actions-col">
        <button class="like-btn ${track.isLiked ? 'liked' : ''}" title="Мне нравится">
          <svg xmlns="http://www.w3.org/2000/svg" height="18px" viewBox="0 -960 960 960" width="18px" fill="currentColor">
            <path d="m480-120-58-52q-101-91-167-157T150-447.5Q111-500 95.5-544.5T80-634q0-94 63-157t157-63q52 0 99 22t81 62q34-40 81-62t99-22q94 0 157 63t63 157q0 45-15.5 89.5T810-447.5q-39 52.5-105 118.5T538-172l-58 52Z"/>
          </svg>
        </button>
      </td>
    `;

    // Play on click
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.like-btn')) return;
      window.localPlayer.playTrack(track, trackList);
    });

    // Context menu
    tr.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.showContextMenu(e.clientX, e.clientY, track);
    });

    // Like button
    const likeBtn = tr.querySelector('.like-btn');
    likeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.api.library.toggleLike(track.id).then(isLiked => {
        track.isLiked = isLiked;
        likeBtn.classList.toggle('liked', isLiked);
        if (window.localPlayer?.queue[window.localPlayer?.currentIndex]?.id === track.id) {
          document.getElementById('player-like-btn')?.classList.toggle('liked', isLiked);
        }
      });
    });

    return tr;
  }

  // ==========================================
  // Albums Rendering & Details
  // ==========================================
  renderAlbums() {
    const grid = document.getElementById('albums-grid');
    if (!grid) return;

    grid.innerHTML = '';

    // Filter albums by search query
    let filteredAlbums = [...this.albums];
    if (this.albumSearchQuery) {
      filteredAlbums = filteredAlbums.filter(a => {
        const title = (a.title || '').toLowerCase();
        const artist = (a.artist || '').toLowerCase();
        const yearStr = a.year ? String(a.year) : '';
        return title.includes(this.albumSearchQuery) ||
               artist.includes(this.albumSearchQuery) ||
               yearStr.includes(this.albumSearchQuery);
      });
    }

    // Sort albums according to albumSortMode
    if (this.albumSortMode === 'year-desc') {
      filteredAlbums.sort((a, b) => {
        const yearA = parseInt(a.year, 10) || 0;
        const yearB = parseInt(b.year, 10) || 0;
        if (yearA !== yearB) return yearB - yearA;
        return (a.title || '').localeCompare(b.title || '', undefined, { numeric: true });
      });
    } else if (this.albumSortMode === 'year-asc') {
      filteredAlbums.sort((a, b) => {
        const yearA = parseInt(a.year, 10) || 9999;
        const yearB = parseInt(b.year, 10) || 9999;
        if (yearA !== yearB) return yearA - yearB;
        return (a.title || '').localeCompare(b.title || '', undefined, { numeric: true });
      });
    } else if (this.albumSortMode === 'name') {
      filteredAlbums.sort((a, b) => (a.title || '').localeCompare(b.title || '', undefined, { numeric: true }));
    } else if (this.albumSortMode === 'tracks') {
      filteredAlbums.sort((a, b) => (b.tracksCount || 0) - (a.tracksCount || 0));
    }

    if (filteredAlbums.length === 0) {
      if (this.albums.length === 0) {
        grid.innerHTML = `
          <div style="grid-column: 1 / -1; margin: 60px auto; text-align: center; padding: 40px 20px;">
            <h2 class="empty-title" style="font-size: 16px; font-weight: 500; color: var(--text-muted);">Ваша медиатека пуста</h2>
          </div>
        `;
      } else {
        grid.innerHTML = '<div style="color: var(--text-muted); padding: 40px; grid-column: 1 / -1; text-align: center;">Альбомы не найдены по вашему запросу</div>';
      }
      return;
    }

    filteredAlbums.forEach(album => {
      const card = document.createElement('div');
      card.className = 'music-card';

      const artHtml = album.coverArt 
        ? `<img class="card-art-img" src="${album.coverArt}" alt="album" />`
        : `<div class="card-art-placeholder">
            <svg xmlns="http://www.w3.org/2000/svg" height="40px" viewBox="0 -960 960 960" width="40px" fill="currentColor">
              <path d="M400-120q-66 0-113-47t-47-113q0-66 47-113t113-47q23 0 42.5 5.5T480-418v-422h240v160H560v400q0 66-47 113t-113 47Z"/>
            </svg>
          </div>`;

      card.innerHTML = `
        <div class="card-art-wrap">
          ${artHtml}
          <div class="card-play-overlay" title="Слушать альбом">
            <svg xmlns="http://www.w3.org/2000/svg" height="22px" viewBox="0 -960 960 960" width="22px" fill="currentColor">
              <path d="M320-200v-560l440 280-440 280Z"/>
            </svg>
          </div>
        </div>
        <div class="card-title" title="${album.title}">${album.title}</div>
        <div class="card-subtitle" title="${album.artist}">${album.artist}</div>
        <div class="card-meta">${album.tracksCount} треков ${album.year ? '• ' + album.year : ''}</div>
      `;

      // Quick play on overlay click
      card.querySelector('.card-play-overlay').addEventListener('click', (e) => {
        e.stopPropagation();
        if (album.tracks.length > 0) {
          window.localPlayer.setQueue(album.tracks, 0);
        }
      });

      // Open album details on card click
      card.addEventListener('click', () => {
        this.openAlbumDetails(album);
      });

      grid.appendChild(card);
    });
  }

  openAlbumDetails(album) {
    this.selectedAlbum = album;
    this.switchSubnav('album-details');

    const coverImg = document.getElementById('album-details-cover');
    const titleEl = document.getElementById('album-details-title');
    const artistEl = document.getElementById('album-details-artist');
    const metaEl = document.getElementById('album-details-meta');
    const tbody = document.getElementById('album-details-tbody');

    if (coverImg) {
      if (album.coverArt) {
        coverImg.src = album.coverArt;
        coverImg.style.display = 'block';
      } else {
        coverImg.src = '';
        coverImg.style.display = 'none';
      }
    }

    if (titleEl) titleEl.textContent = album.title || 'Без названия';
    if (artistEl) artistEl.textContent = album.artist || 'Неизвестный исполнитель';
    if (metaEl) {
      const totalMin = Math.round(album.totalDuration / 60);
      metaEl.textContent = `${album.tracksCount} треков • ${totalMin} мин ${album.year ? '• ' + album.year : ''}`;
    }

    if (tbody) {
      tbody.innerHTML = '';
      if (!album.tracks || album.tracks.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 40px; color: var(--text-muted);">В этом альбоме нет треков</td></tr>';
      } else {
        album.tracks.forEach((track, idx) => {
          const tr = this.createTrackTableRow(track, idx + 1, album.tracks);
          tbody.appendChild(tr);
        });
      }
    }
  }

  // Show where a track lives in the library: its album if it has one, otherwise the tracks list
  revealTrack(track) {
    if (!track) return;
    const album = this.albums.find(a => Array.isArray(a.tracks) && a.tracks.some(t => t.id === track.id));
    let viewId;

    if (album) {
      this.openAlbumDetails(album);
      viewId = 'library-subview-album-details';
    } else {
      // Make sure filters/search don't hide the track
      this.searchQuery = '';
      const searchInput = document.getElementById('library-search-input');
      if (searchInput) searchInput.value = '';
      this.currentFilter = 'all';
      document.querySelectorAll('.filter-pill').forEach(p => p.classList.toggle('active', (p.dataset.filter || 'all') === 'all'));
      this.switchSubnav('tracks');
      viewId = 'library-subview-tracks';
    }

    requestAnimationFrame(() => {
      const row = Array.from(document.querySelectorAll(`#${viewId} .track-row`)).find(r => r.dataset.id === String(track.id));
      if (!row) return;
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.classList.remove('track-row-flash');
      void row.offsetWidth; // restart the animation
      row.classList.add('track-row-flash');
      setTimeout(() => row.classList.remove('track-row-flash'), 1800);
    });
  }

  // ==========================================
  // Playlists Rendering & Details
  // ==========================================
  renderPlaylists() {
    const grid = document.getElementById('playlists-grid');
    if (!grid) return;

    grid.innerHTML = '';

    // Create New Playlist Card
    const createCard = document.createElement('div');
    createCard.className = 'create-playlist-card';
    createCard.innerHTML = `
      <div class="create-card-icon">
        <svg xmlns="http://www.w3.org/2000/svg" height="28px" viewBox="0 -960 960 960" width="28px" fill="currentColor">
          <path d="M440-440H200v-80h240v-240h80v240h240v80H520v240h-80v-240Z"/>
        </svg>
      </div>
      <div style="font-weight: 600; font-size: 14px; color: var(--text-highlight);">Создать плейлист</div>
      <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">Соберите свою подборку треков</div>
    `;
    createCard.addEventListener('click', () => this.openCreatePlaylistModal());
    grid.appendChild(createCard);

    this.playlists.forEach(pl => {
      const card = document.createElement('div');
      card.className = 'music-card';

      const artHtml = pl.coverArt 
        ? `<img class="card-art-img" src="${pl.coverArt}" alt="playlist" />`
        : `<div class="card-art-placeholder">
            <svg xmlns="http://www.w3.org/2000/svg" height="40px" viewBox="0 -960 960 960" width="40px" fill="currentColor">
              <path d="M120-320v-80h320v80H120Zm0-160v-80h480v80H120Zm0-160v-80h480v80H120Zm520 480v-320l240 160-240 160Z"/>
            </svg>
          </div>`;

      card.innerHTML = `
        <div class="card-art-wrap">
          ${artHtml}
          <div class="card-play-overlay" title="Слушать плейлист">
            <svg xmlns="http://www.w3.org/2000/svg" height="22px" viewBox="0 -960 960 960" width="22px" fill="currentColor">
              <path d="M320-200v-560l440 280-440 280Z"/>
            </svg>
          </div>
        </div>
        <div class="card-title" title="${pl.name}">${pl.name}</div>
        <div class="card-meta">${pl.tracksCount} треков</div>
      `;

      card.querySelector('.card-play-overlay').addEventListener('click', (e) => {
        e.stopPropagation();
        if (pl.tracks.length > 0) {
          window.localPlayer.setQueue(pl.tracks, 0);
        }
      });

      card.addEventListener('click', () => {
        this.openPlaylistDetails(pl);
      });

      grid.appendChild(card);
    });
  }

  openPlaylistDetails(pl) {
    this.selectedPlaylist = pl;
    this.switchSubnav('playlist-details');

    const titleEl = document.getElementById('playlist-details-title');
    const metaEl = document.getElementById('playlist-details-meta');
    const tbody = document.getElementById('playlist-details-tbody');
    const deleteBtn = document.getElementById('btn-delete-current-playlist');

    if (titleEl) titleEl.textContent = pl.name;
    if (metaEl) metaEl.textContent = `${pl.tracksCount} треков в плейлисте`;

    const editBtn = document.getElementById('btn-edit-current-playlist');
    if (editBtn) editBtn.onclick = () => this.openPlaylistEditor(this.selectedPlaylist || pl);

    if (deleteBtn) {
      deleteBtn.onclick = async () => {
        if (confirm(`Удалить плейлист "${pl.name}"?`)) {
          this.playlists = await window.api.library.deletePlaylist(pl.id);
          this.switchSubnav('playlists');
        }
      };
    }

    if (tbody) {
      tbody.innerHTML = '';
      if (pl.tracks.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 40px; color: var(--text-muted);">В этом плейлисте пока нет треков. Нажмите «Редактировать», чтобы добавить их.</td></tr>';
      } else {
        pl.tracks.forEach((track, idx) => {
          const tr = this.createTrackTableRow(track, idx + 1, pl.tracks);
          tbody.appendChild(tr);
        });
      }
    }
  }

  // Playlist editor (create + edit): name, library search, track picker
  bindPlaylistModal() {
    const modal = document.getElementById('create-playlist-modal');
    const closeBtn = document.getElementById('btn-close-playlist-modal');
    const submitBtn = document.getElementById('btn-submit-create-playlist');
    const input = document.getElementById('create-playlist-name-input');
    const search = document.getElementById('playlist-editor-search');
    const list = document.getElementById('playlist-editor-list');
    const filter = document.getElementById('playlist-editor-filter');
    if (!modal || !submitBtn || !input || !list) return;

    // { playlistId|null, selected: ordered trackIds, filter }
    this.playlistEditor = null;

    closeBtn?.addEventListener('click', () => modal.classList.remove('active'));

    submitBtn.addEventListener('click', async () => {
      const ed = this.playlistEditor;
      if (!ed) return;
      const name = input.value.trim();
      if (!name) {
        input.focus();
        input.classList.add('input-error');
        setTimeout(() => input.classList.remove('input-error'), 800);
        return;
      }
      submitBtn.disabled = true;
      try {
        if (ed.playlistId) {
          const current = this.playlists.find(p => p.id === ed.playlistId);
          if (current && current.name !== name) await window.api.library.renamePlaylist(ed.playlistId, name);
          this.playlists = await window.api.library.setPlaylistTracks(ed.playlistId, ed.selected);
          const updated = this.playlists.find(p => p.id === ed.playlistId);
          if (updated && this.currentSubnav === 'playlist-details') this.openPlaylistDetails(updated);
        } else {
          this.playlists = await window.api.library.createPlaylist(name, ed.selected);
          window.appController?.showToast(`Плейлист «${name}» создан`, 'info');
        }
        this.renderPlaylists();
        this.updateBadgeCount();
        modal.classList.remove('active');
      } catch (err) {
        console.error('Failed to save playlist:', err);
        window.appController?.showToast(`Не удалось сохранить плейлист: ${err.message || err}`, 'error');
      } finally {
        submitBtn.disabled = false;
      }
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitBtn.click();
    });

    let searchTimer = null;
    search?.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => this.renderPlaylistEditorList(), 120);
    });

    filter?.addEventListener('click', (e) => {
      const btn = e.target.closest('.pe-filter-btn');
      if (!btn || !this.playlistEditor) return;
      this.playlistEditor.filter = btn.dataset.filter;
      filter.querySelectorAll('.pe-filter-btn').forEach(b => b.classList.toggle('active', b === btn));
      this.renderPlaylistEditorList();
    });

    // toggle a track: clicking anywhere on the row
    list.addEventListener('click', (e) => {
      const row = e.target.closest('.pe-row');
      const ed = this.playlistEditor;
      if (!row || !ed) return;
      const id = row.dataset.id;
      const idx = ed.selected.indexOf(id);
      if (idx >= 0) ed.selected.splice(idx, 1);
      else ed.selected.push(id);
      const on = idx < 0;
      row.classList.toggle('selected', on);
      row.setAttribute('aria-checked', String(on));
      this.updatePlaylistEditorCount();
    });
  }

  openCreatePlaylistModal(preselectTrackIds = []) {
    this.openPlaylistEditor(null, preselectTrackIds);
  }

  openPlaylistEditor(playlist = null, preselectTrackIds = []) {
    const modal = document.getElementById('create-playlist-modal');
    const input = document.getElementById('create-playlist-name-input');
    const title = document.getElementById('playlist-editor-title');
    const submitBtn = document.getElementById('btn-submit-create-playlist');
    const search = document.getElementById('playlist-editor-search');
    if (!modal) return;

    this.playlistEditor = {
      playlistId: playlist ? playlist.id : null,
      selected: playlist ? (playlist.tracks || []).map(t => t.id) : [...preselectTrackIds],
      filter: 'all'
    };

    if (title) title.textContent = playlist ? 'Редактировать плейлист' : 'Новый плейлист';
    if (submitBtn) submitBtn.textContent = playlist ? 'Сохранить' : 'Создать плейлист';
    if (input) input.value = playlist ? playlist.name : '';
    if (search) search.value = '';
    document.querySelectorAll('#playlist-editor-filter .pe-filter-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.filter === 'all');
    });

    this.renderPlaylistEditorList();
    modal.classList.add('active');
    const listEl = document.getElementById('playlist-editor-list');
    if (listEl) listEl.scrollTop = 0;
    if (input) setTimeout(() => input.focus(), 100);
  }

  updatePlaylistEditorCount() {
    const el = document.getElementById('playlist-editor-count');
    if (el && this.playlistEditor) el.textContent = this.playlistEditor.selected.length;
    // in the "Добавленные" view an unchecked row stays until the list is redrawn, so it can be re-checked
  }

  renderPlaylistEditorList() {
    const list = document.getElementById('playlist-editor-list');
    const ed = this.playlistEditor;
    if (!list || !ed) return;

    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const query = (document.getElementById('playlist-editor-search')?.value || '').trim().toLowerCase();
    const selectedSet = new Set(ed.selected);
    const byId = new Map(this.tracks.map(t => [t.id, t]));

    let items;
    if (ed.filter === 'added') {
      // playlist order
      items = ed.selected.map(id => byId.get(id)).filter(Boolean);
    } else {
      // added tracks first, then the rest of the library
      const rest = this.tracks.filter(t => !selectedSet.has(t.id));
      items = [...ed.selected.map(id => byId.get(id)).filter(Boolean), ...rest];
    }
    if (query) {
      items = items.filter(t => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(query));
    }

    this.updatePlaylistEditorCount();

    if (items.length === 0) {
      const msg = this.tracks.length === 0
        ? 'Медиатека пуста — сначала добавьте музыку'
        : ed.filter === 'added' && !query ? 'В плейлисте пока нет треков' : 'Ничего не найдено';
      list.innerHTML = `<div class="pe-empty">${msg}</div>`;
      return;
    }

    const note = '<path d="M400-120q-66 0-113-47t-47-113q0-66 47-113t113-47q23 0 42.5 5.5T480-418v-422h240v160H560v400q0 66-47 113t-113 47Z"/>';
    list.innerHTML = items.map(t => {
      const on = selectedSet.has(t.id);
      const art = t.coverArt
        ? `<img src="${esc(t.coverArt)}" alt="" loading="lazy" decoding="async" />`
        : `<svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 -960 960 960" width="16px" fill="currentColor">${note}</svg>`;
      return `
        <div class="pe-row${on ? ' selected' : ''}" data-id="${esc(t.id)}" role="checkbox" aria-checked="${on}">
          <div class="pe-art">${art}</div>
          <div class="pe-info">
            <span class="pe-title">${esc(t.title || 'Без названия')}</span>
            <span class="pe-artist">${esc(t.artist || 'Неизвестный артист')}${t.album ? ' · ' + esc(t.album) : ''}</span>
          </div>
          <span class="pe-duration">${this.formatTime(t.duration)}</span>
          <span class="pe-check" title="${on ? 'Убрать из плейлиста' : 'Добавить в плейлист'}">
            <svg class="pe-icon-add" xmlns="http://www.w3.org/2000/svg" height="18px" viewBox="0 -960 960 960" width="18px" fill="currentColor"><path d="M440-440H200v-80h240v-240h80v240h240v80H520v240h-80v-240Z"/></svg>
            <svg class="pe-icon-on" xmlns="http://www.w3.org/2000/svg" height="18px" viewBox="0 -960 960 960" width="18px" fill="currentColor"><path d="M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z"/></svg>
          </span>
        </div>`;
    }).join('');
  }

  // Context Menu Logic
  bindContextMenu() {
    const menu = document.getElementById('track-context-menu');
    if (!menu) return;

    window.addEventListener('click', (e) => {
      if (!menu.contains(e.target)) {
        menu.classList.remove('active');
      }
    });

    document.getElementById('ctx-play')?.addEventListener('click', () => {
      if (this.contextTargetTrack) {
        window.localPlayer.playTrack(this.contextTargetTrack);
      }
      menu.classList.remove('active');
    });

    document.getElementById('ctx-play-next')?.addEventListener('click', () => {
      if (this.contextTargetTrack && window.localPlayer) {
        window.localPlayer.playNext(this.contextTargetTrack);
      }
      menu.classList.remove('active');
    });

    document.getElementById('ctx-edit')?.addEventListener('click', () => {
      if (this.contextTargetTrack) {
        this.openEditTrackModal(this.contextTargetTrack);
      }
      menu.classList.remove('active');
    });

    document.getElementById('ctx-like')?.addEventListener('click', () => {
      if (this.contextTargetTrack) {
        window.api.library.toggleLike(this.contextTargetTrack.id).then(isLiked => {
          this.contextTargetTrack.isLiked = isLiked;
          this.refreshLikes();
        });
      }
      menu.classList.remove('active');
    });

    document.getElementById('ctx-show-folder')?.addEventListener('click', () => {
      if (this.contextTargetTrack) {
        window.api.app.showItemInFolder(this.contextTargetTrack.filePath);
      }
      menu.classList.remove('active');
    });

    document.getElementById('ctx-delete')?.addEventListener('click', async () => {
      if (!this.contextTargetTrack) return;
      const track = this.contextTargetTrack;
      menu.classList.remove('active');

      const confirmed = confirm(`Удалить трек «${track.artist} - ${track.title}»?\nФайл будет удалён с диска.`);
      if (!confirmed) return;

      try {
        const res = await window.api.library.deleteTrack(track.id, true);
        if (res && res.success) {
          window.appController?.showToast(`Трек «${track.artist} - ${track.title}» удалён`, 'info');
          await this.loadTracks();
          await this.loadAlbums();
          await this.loadPlaylists();
        }
      } catch (err) {
        console.error('Failed to delete track:', err);
        window.appController?.showToast(`Ошибка удаления: ${err.message || err}`, 'error');
      }
    });
  }

  showContextMenu(x, y, track) {
    this.contextTargetTrack = track;
    const menu = document.getElementById('track-context-menu');
    const playlistsContainer = document.getElementById('ctx-playlists-submenu');
    if (!menu) return;

    // Populate playlists submenu
    if (playlistsContainer) {
      playlistsContainer.innerHTML = '';
      if (this.playlists.length === 0) {
        playlistsContainer.innerHTML = '<div style="padding: 6px 12px; color: var(--text-muted); font-size: 11px;">Нет плейлистов</div>';
      } else {
        this.playlists.forEach(pl => {
          const item = document.createElement('div');
          item.className = 'context-item';
          item.textContent = pl.name;
          item.addEventListener('click', async (e) => {
            e.stopPropagation();
            this.playlists = await window.api.library.addTrackToPlaylist(pl.id, track.id);
            menu.classList.remove('active');
          });
          playlistsContainer.appendChild(item);
        });
      }

      // Add "New Playlist..." item
      const newItem = document.createElement('div');
      newItem.className = 'context-item';
      newItem.style.borderTop = '1px solid var(--border-subtle)';
      newItem.style.color = '#818cf8';
      newItem.textContent = '+ Новый плейлист...';
      newItem.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.remove('active');
        // the clicked track is already checked in the new playlist
        this.openCreatePlaylistModal([track.id]);
      });
      playlistsContainer.appendChild(newItem);
    }

    // Position menu safely on screen
    const menuWidth = 220;
    const menuHeight = 260;
    const posX = (x + menuWidth > window.innerWidth) ? x - menuWidth : x;
    const posY = (y + menuHeight > window.innerHeight) ? y - menuHeight : y;

    menu.style.left = `${posX}px`;
    menu.style.top = `${posY}px`;
    menu.classList.add('active');
  }

  refreshLikes() {
    this.renderTracks();
    if (this.selectedAlbum) this.openAlbumDetails(this.selectedAlbum);
    if (this.selectedPlaylist) this.openPlaylistDetails(this.selectedPlaylist);
  }
}

window.libraryUI = new LibraryUI();
