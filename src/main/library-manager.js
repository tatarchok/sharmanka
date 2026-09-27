const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mm = require('music-metadata');
const { app } = require('electron');
const { remoteStorage, isRemotePath, canonicalUrl, urlPath } = require('./remote-storage');
const { CoverFinder } = require('./cover-finder');

const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.m4a', '.flac', '.wav', '.aac', '.ogg', '.wma', '.opus', '.alac', '.aiff'
]);

const COVER_FILE_NAMES = [
  'cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp',
  'folder.jpg', 'folder.jpeg', 'folder.png',
  'front.jpg', 'front.jpeg', 'front.png',
  'album.jpg', 'album.png', 'artwork.jpg', 'artwork.png'
];

const MIME_BY_EXT = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.alac': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/opus', '.wma': 'audio/x-ms-wma', '.aiff': 'audio/aiff'
};

// Bump when remote tag reading improves: cached remote tracks without a cover are re-read once
const REMOTE_META_VERSION = 2;

// Folder names used for multi-disc albums (CD1, Disc 2 ...)
const DISC_FOLDER_RE = /^(cd|disc|disk)\s*\d+$/i;

class LibraryManager {
  constructor(configStore) {
    this.configStore = configStore;
    this.userDataPath = app.getPath('userData');
    this.cachePath = path.join(this.userDataPath, 'library-cache.json');
    this.remoteCoversPath = path.join(this.userDataPath, 'remote-covers.json');
    this.artCacheDir = path.join(this.userDataPath, 'album-art');

    if (!fs.existsSync(this.artCacheDir)) {
      fs.mkdirSync(this.artCacheDir, { recursive: true });
    }

    remoteStorage.configure((configStore.get('library') || {}).remote);

    this.coverFinder = new CoverFinder(this.userDataPath, this.artCacheDir);
    this.coverSearchRunning = false;

    this.tracks = new Map(); // id -> track object
    this.remoteFolderCovers = {}; // remote folder URL -> atom:// cover
    try {
      if (fs.existsSync(this.remoteCoversPath)) {
        this.remoteFolderCovers = JSON.parse(fs.readFileSync(this.remoteCoversPath, 'utf8')) || {};
      }
    } catch (e) {}
    this.loadCache();
  }

  // ---- local/remote path helpers ------------------------------------------
  // Comparable key of a folder or file (case-insensitive for Windows paths, exact for URLs)
  _key(p) {
    return isRemotePath(p) ? canonicalUrl(p) : path.resolve(p).toLowerCase();
  }

  _isInside(rootKey, fileKey) {
    if (isRemotePath(rootKey)) return isRemotePath(fileKey) && urlPath.isInside(rootKey, fileKey);
    return fileKey === rootKey || fileKey.startsWith(rootKey + path.sep);
  }

  _dirname(p) {
    return isRemotePath(p) ? urlPath.dirname(p) : path.dirname(p);
  }

  _basename(p) {
    return isRemotePath(p) ? urlPath.basename(p) : path.basename(p);
  }

  _extname(p) {
    return (isRemotePath(p) ? urlPath.extname(p) : path.extname(p)).toLowerCase();
  }

  _rootExists(p) {
    if (isRemotePath(p)) return remoteStorage.isConfigured();
    try { return fs.existsSync(p); } catch (e) { return false; }
  }

  _configuredRoots() {
    const libraryConfig = this.configStore.get('library') || {};
    const roots = [];
    const seen = new Set();
    const add = (p) => {
      if (!p || typeof p !== 'string' || !p.trim()) return;
      const key = this._key(p);
      if (seen.has(key)) return;
      seen.add(key);
      roots.push(isRemotePath(p) ? canonicalUrl(p) : path.resolve(p));
    };
    add(libraryConfig.musicFolder);
    if (Array.isArray(libraryConfig.folders)) libraryConfig.folders.forEach(add);
    return roots;
  }

  saveRemoteCovers() {
    try {
      fs.writeFileSync(this.remoteCoversPath, JSON.stringify(this.remoteFolderCovers, null, 2), 'utf8');
    } catch (e) {}
  }

  loadCache() {
    try {
      const validRoots = this._configuredRoots().map(r => this._key(r));

      // If user has not configured any music folders, the library is empty
      if (validRoots.length === 0) {
        this.tracks.clear();
        this.saveCache();
        return;
      }

      if (fs.existsSync(this.cachePath)) {
        const raw = fs.readFileSync(this.cachePath, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          for (const track of data) {
            if (!track || !track.filePath) continue;
            const trackKey = this._key(track.filePath);
            const isValid = validRoots.some(root => this._isInside(root, trackKey));
            // Remote files are trusted from the cache; the next scan reconciles them with the server
            if (isValid && (isRemotePath(track.filePath) || fs.existsSync(track.filePath))) {
              this.tracks.set(track.id, track);
            }
          }
        }
      }
    } catch (e) {
      console.warn('Could not load library cache:', e.message);
    }
  }

  saveCache() {
    try {
      const data = Array.from(this.tracks.values());
      fs.writeFileSync(this.cachePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      console.error('Could not save library cache:', e.message);
    }
  }

  getTrackList() {
    const libraryConfig = this.configStore.get('library') || {};
    const likedSet = new Set(libraryConfig.likedTrackIds || []);
    return Array.from(this.tracks.values())
      .sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
      .map(t => ({
        ...t,
        isLiked: likedSet.has(t.id)
      }));
  }

  toggleLike(trackId) {
    const libraryConfig = this.configStore.get('library') || {};
    const liked = new Set(libraryConfig.likedTrackIds || []);
    if (liked.has(trackId)) {
      liked.delete(trackId);
    } else {
      liked.add(trackId);
    }
    libraryConfig.likedTrackIds = Array.from(liked);
    this.configStore.set('library', libraryConfig);
    return liked.has(trackId);
  }

  async deleteTrack(trackId, deleteFromDisk = true) {
    const track = this.tracks.get(trackId);
    if (!track) {
      throw new Error('Трек не найден в медиатеке');
    }

    if (deleteFromDisk && track.filePath && isRemotePath(track.filePath)) {
      try {
        await remoteStorage.remove(track.filePath);
      } catch (err) {
        throw new Error(`Не удалось удалить файл на сервере: ${err.message}`);
      }
    } else if (deleteFromDisk && track.filePath && fs.existsSync(track.filePath)) {
      try {
        fs.unlinkSync(track.filePath);
      } catch (err) {
        console.error('Error deleting file from disk:', track.filePath, err);
        throw new Error(`Не удалось удалить файл: ${err.message}`);
      }
    }

    // Remove from this.tracks
    this.tracks.delete(trackId);

    // Remove from liked track IDs
    const libraryConfig = this.configStore.get('library') || {};
    if (Array.isArray(libraryConfig.likedTrackIds)) {
      libraryConfig.likedTrackIds = libraryConfig.likedTrackIds.filter(id => id !== trackId);
    }

    // Remove from custom albums
    if (Array.isArray(libraryConfig.albums)) {
      libraryConfig.albums.forEach(album => {
        if (Array.isArray(album.trackIds)) {
          album.trackIds = album.trackIds.filter(id => id !== trackId);
        }
      });
    }

    // Remove from playlists
    if (Array.isArray(libraryConfig.playlists)) {
      libraryConfig.playlists.forEach(pl => {
        if (Array.isArray(pl.trackIds)) {
          pl.trackIds = pl.trackIds.filter(id => id !== trackId);
        }
      });
    }

    this.configStore.set('library', libraryConfig);
    this.saveCache();

    return { success: true, trackId };
  }

  sortAlbumTracks(trackList) {
    return [...trackList].sort((a, b) => {
      // 1. Disc number
      const discA = typeof a.discNumber === 'number' && a.discNumber > 0 ? a.discNumber : 1;
      const discB = typeof b.discNumber === 'number' && b.discNumber > 0 ? b.discNumber : 1;
      if (discA !== discB) return discA - discB;

      // 2. Track number
      const noA = typeof a.trackNumber === 'number' && a.trackNumber > 0 ? a.trackNumber : 0;
      const noB = typeof b.trackNumber === 'number' && b.trackNumber > 0 ? b.trackNumber : 0;
      if (noA > 0 && noB > 0 && noA !== noB) return noA - noB;

      // 3. Natural filename comparison (handles "01 - track", "2. track", "10 track")
      const nameA = a.filename || a.title || '';
      const nameB = b.filename || b.title || '';
      return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
    });
  }

  getAlbums() {
    const config = this.configStore.get();
    const libraryConfig = config.library || {};
    const customAlbums = libraryConfig.albums || [];
    const allTracks = this.getTrackList();

    const processedTrackIds = new Set();
    const resultAlbums = [];

    // Map of custom overrides by album folder path / ID
    const customAlbumMap = new Map();
    for (const ca of customAlbums) {
      if (ca.id) customAlbumMap.set(ca.id, ca);
      if (ca.folderPath) customAlbumMap.set(this._key(ca.folderPath), ca);
    }

    // 1. Discover all album directories in configured music folders
    const allRootFolders = this._configuredRoots()
      .filter(root => this._rootExists(root))
      .map(root => ({ path: root, source: 'local' }));

    const albumFolderDirs = [];
    const discoveredPaths = new Set();

    for (const root of allRootFolders) {
      const found = isRemotePath(root.path)
        ? this._discoverRemoteAlbumFolders(root.path, allTracks, root.source)
        : this._discoverAlbumFolders(root.path, root.source);
      for (const item of found) {
        const norm = this._key(item.folderPath);
        if (!discoveredPaths.has(norm)) {
          discoveredPaths.add(norm);
          albumFolderDirs.push(item);
        }
      }
    }

    for (const { folderPath, folderName, source } of albumFolderDirs) {
      const normFolderPath = this._key(folderPath);
      const albumTracks = [];

      for (const t of allTracks) {
        const trackDirPath = this._key(this._dirname(t.filePath));
        if (this._isInside(normFolderPath, trackDirPath)) {
          albumTracks.push(t);
        }
      }

      if (albumTracks.length === 0) continue;

      const albumId = 'album_' + crypto.createHash('md5').update(normFolderPath).digest('hex');
      const customOverride = customAlbumMap.get(albumId) || customAlbumMap.get(normFolderPath);

      // Extract common metadata
      const artistCounts = {};
      const albumCounts = {};
      let detectedYear = null;
      let detectedCover = null;

      for (const t of albumTracks) {
        processedTrackIds.add(t.id);
        if (t.artist && t.artist !== 'Неизвестный исполнитель') {
          artistCounts[t.artist] = (artistCounts[t.artist] || 0) + 1;
        }
        if (t.album && t.album !== 'Неизвестный альбом' && t.album !== 'Без альбома') {
          albumCounts[t.album] = (albumCounts[t.album] || 0) + 1;
        }
        if (!detectedYear && t.year) detectedYear = t.year;
        if (!detectedCover && t.coverArt) detectedCover = t.coverArt;
      }

      const mostCommonArtist = Object.keys(artistCounts).sort((a, b) => artistCounts[b] - artistCounts[a])[0] || 'Неизвестный исполнитель';
      const mostCommonAlbum = Object.keys(albumCounts).sort((a, b) => albumCounts[b] - albumCounts[a])[0] || folderName;

      // Check folder cover image file (remote covers are downloaded during the scan)
      let finalCover = detectedCover;
      if (isRemotePath(folderPath)) {
        if (this.remoteFolderCovers[normFolderPath]) finalCover = this.remoteFolderCovers[normFolderPath];
      } else {
        const folderCover = this._findFolderCoverImage(folderPath);
        if (folderCover) {
          finalCover = this._copyCoverArtToCache(albumId, folderCover);
        }
      }

      const sortedTracks = this.sortAlbumTracks(albumTracks);
      const totalDuration = sortedTracks.reduce((acc, t) => acc + (t.duration || 0), 0);

      resultAlbums.push({
        id: albumId,
        title: customOverride?.title || mostCommonAlbum || folderName,
        artist: customOverride?.artist || mostCommonArtist,
        year: customOverride?.year || detectedYear,
        coverArt: customOverride?.coverArt || finalCover,
        tracks: sortedTracks,
        tracksCount: sortedTracks.length,
        totalDuration,
        source,
        folderPath,
        isCustom: !!customOverride
      });
    }

    // 2. Any remaining custom albums manually created that don't match existing folder
    for (const ca of customAlbums) {
      if (resultAlbums.some(ra => ra.id === ca.id)) continue;
      const albumTracks = allTracks.filter(t => Array.isArray(ca.trackIds) && ca.trackIds.includes(t.id));
      if (albumTracks.length === 0) continue;
      const sortedTracks = this.sortAlbumTracks(albumTracks);
      resultAlbums.push({
        id: ca.id,
        title: ca.title || 'Альбом',
        artist: ca.artist || 'Неизвестный исполнитель',
        year: ca.year || null,
        coverArt: ca.coverArt || sortedTracks.find(t => t.coverArt)?.coverArt || null,
        tracks: sortedTracks,
        tracksCount: sortedTracks.length,
        totalDuration: sortedTracks.reduce((acc, t) => acc + (t.duration || 0), 0),
        source: 'local',
        folderPath: ca.folderPath || null,
        isCustom: true
      });
    }

    return resultAlbums.sort((a, b) => (a.title || '').localeCompare(b.title || '', undefined, { numeric: true }));
  }

  async addAlbumFromFolder(folderPath) {
    if (!folderPath || !fs.existsSync(folderPath)) {
      throw new Error('Указанная папка не существует');
    }

    const resolvedFolder = path.resolve(folderPath);
    const audioFiles = this._scanDirRecursively(resolvedFolder);

    if (audioFiles.length === 0) {
      throw new Error('В выбранной папке не найдены поддерживаемые аудиофайлы (MP3, FLAC, M4A и др.)');
    }

    // Add folder to config folders if not present
    const config = this.configStore.get();
    const customFolders = config.library?.folders || [];
    if (!customFolders.some(f => path.resolve(f).toLowerCase() === resolvedFolder.toLowerCase())) {
      customFolders.push(resolvedFolder);
      config.library = { ...(config.library || {}), folders: customFolders };
      this.configStore.set('library', config.library);
    }

    // Parse any new files into this.tracks
    const parsedTracks = [];
    for (const f of audioFiles) {
      const trackId = this._generateTrackId(f);
      let track = this.tracks.get(trackId);
      if (!track) {
        try {
          const stat = fs.statSync(f);
          track = await this._parseAudioFile(f, stat, 'local', trackId);
          this.tracks.set(trackId, track);
        } catch (err) {
          console.warn('Error parsing file in album:', f, err);
        }
      }
      if (track) parsedTracks.push(track);
    }
    this.saveCache();

    // Determine default album title, artist, year, and cover
    const folderName = path.basename(resolvedFolder);
    const albumCounts = {};
    const artistCounts = {};
    let detectedYear = null;
    let detectedCover = null;

    for (const t of parsedTracks) {
      if (t.album && t.album !== 'Неизвестный альбом' && t.album !== 'Без альбома') {
        albumCounts[t.album] = (albumCounts[t.album] || 0) + 1;
      }
      if (t.artist && t.artist !== 'Неизвестный исполнитель') {
        artistCounts[t.artist] = (artistCounts[t.artist] || 0) + 1;
      }
      if (!detectedYear && t.year) detectedYear = t.year;
      if (!detectedCover && t.coverArt) detectedCover = t.coverArt;
    }

    const mostCommonAlbum = Object.keys(albumCounts).sort((a, b) => albumCounts[b] - albumCounts[a])[0];
    const mostCommonArtist = Object.keys(artistCounts).sort((a, b) => artistCounts[b] - artistCounts[a])[0];

    const title = mostCommonAlbum || folderName;
    const artist = mostCommonArtist || 'Неизвестный исполнитель';

    // Check for folder cover image file
    const folderCover = this._findFolderCoverImage(resolvedFolder);
    const albumId = 'album_' + crypto.createHash('md5').update(resolvedFolder.toLowerCase()).digest('hex');

    let finalCoverArt = detectedCover;
    if (folderCover) {
      finalCoverArt = this._copyCoverArtToCache(albumId, folderCover);
    }

    // Sort tracks in natural album order
    const sortedTracks = this.sortAlbumTracks(parsedTracks);

    const newAlbum = {
      id: albumId,
      folderPath: resolvedFolder,
      title,
      artist,
      year: detectedYear,
      coverArt: finalCoverArt,
      trackIds: sortedTracks.map(t => t.id),
      createdAt: Date.now()
    };

    const libraryConfig = this.configStore.get('library') || {};
    const albums = libraryConfig.albums || [];
    const existingIdx = albums.findIndex(a => a.id === albumId || (a.folderPath && path.resolve(a.folderPath).toLowerCase() === resolvedFolder.toLowerCase()));

    if (existingIdx !== -1) {
      albums[existingIdx] = { ...albums[existingIdx], ...newAlbum, title: albums[existingIdx].title || newAlbum.title };
    } else {
      albums.push(newAlbum);
    }

    libraryConfig.albums = albums;
    this.configStore.set('library', libraryConfig);

    return {
      album: {
        ...newAlbum,
        tracks: sortedTracks,
        tracksCount: sortedTracks.length,
        totalDuration: sortedTracks.reduce((acc, t) => acc + (t.duration || 0), 0)
      },
      albums: this.getAlbums()
    };
  }

  async updateAlbum({ id, title, artist, year, coverArt, customCoverPath }) {
    const libraryConfig = this.configStore.get('library') || {};
    let albums = libraryConfig.albums || [];
    let target = albums.find(a => a.id === id);

    let finalCover = coverArt;
    if (customCoverPath && fs.existsSync(customCoverPath)) {
      finalCover = this._copyCoverArtToCache(id, customCoverPath);
    }

    if (!target) {
      // Might be converting an auto album to a custom album
      target = {
        id,
        title: title || 'Альбом',
        artist: artist || 'Неизвестный исполнитель',
        year: year || null,
        coverArt: finalCover || null,
        trackIds: [],
        createdAt: Date.now()
      };
      albums.push(target);
    }

    if (title !== undefined) target.title = (title && title.trim()) || target.title;
    if (artist !== undefined) target.artist = (artist && artist.trim()) || target.artist;
    if (year !== undefined) target.year = year ? parseInt(year, 10) || null : null;
    if (finalCover !== undefined) target.coverArt = finalCover;

    libraryConfig.albums = albums;
    this.configStore.set('library', libraryConfig);

    return this.getAlbums();
  }

  async updateTrack({ id, title, artist, album, genre, year, customCoverPath, isCoverRemoved }) {
    if (!id) {
      throw new Error('Не указан ID трека');
    }

    const track = this.tracks.get(id);
    if (!track) {
      throw new Error('Трек не найден в медиатеке');
    }

    let NodeID3 = null;
    try {
      NodeID3 = require('node-id3');
    } catch (e) {}

    // 1. Update in-memory metadata
    if (typeof title === 'string' && title.trim()) {
      track.title = title.trim();
    }
    if (typeof artist === 'string' && artist.trim()) {
      track.artist = artist.trim();
    }
    if (typeof album === 'string') {
      track.album = album.trim();
    }
    if (typeof genre === 'string') {
      track.genre = genre.trim();
    }
    if (year !== undefined) {
      track.year = year ? parseInt(year, 10) || null : null;
    }

    // 2. Handle Cover Art
    let coverBuffer = null;
    if (customCoverPath && fs.existsSync(customCoverPath)) {
      try {
        coverBuffer = fs.readFileSync(customCoverPath);
        track.coverArt = this._copyCoverArtToCache(id, customCoverPath);
      } catch (err) {
        console.warn('Failed to update track cover art in cache:', err.message);
      }
    } else if (isCoverRemoved) {
      track.coverArt = null;
    }

    // 3. Write ID3 Tags to physical file if MP3
    const isRemoteFile = isRemotePath(track.filePath);
    if (track.filePath && (isRemoteFile || fs.existsSync(track.filePath)) && NodeID3 && this._extname(track.filePath) === '.mp3') {
      try {
        const tags = {
          title: track.title,
          artist: track.artist,
          album: track.album || '',
          genre: track.genre || undefined,
          year: track.year ? String(track.year) : undefined
        };

        if (coverBuffer) {
          const isPng = customCoverPath?.toLowerCase().endsWith('.png');
          tags.image = {
            mime: isPng ? 'image/png' : 'image/jpeg',
            type: { id: 3, name: 'front cover' },
            description: 'Front Cover',
            imageBuffer: coverBuffer
          };
        } else if (isCoverRemoved) {
          tags.image = undefined;
        }

        if (isRemoteFile) {
          // Download, retag in memory, upload back
          const original = await remoteStorage.readFile(track.filePath);
          const updated = NodeID3.update(tags, original);
          if (Buffer.isBuffer(updated)) {
            await remoteStorage.writeFile(track.filePath, updated);
            track.size = updated.length;
          }
        } else {
          NodeID3.update(tags, track.filePath);
        }
      } catch (err) {
        console.warn('Failed to update ID3 tags in file:', err.message);
      }
    }

    track.mtime = Date.now();
    this.tracks.set(track.id, track);
    this.saveCache();

    return {
      success: true,
      track
    };
  }

  async deleteAlbum(albumId, deleteFromDisk = true) {
    const allAlbums = this.getAlbums();
    const album = allAlbums.find(a => a.id === albumId);

    if (album && deleteFromDisk && album.folderPath && isRemotePath(album.folderPath)) {
      try {
        await remoteStorage.remove(album.folderPath, { isDir: true });
        (album.tracks || []).forEach(t => this.tracks.delete(t.id));
      } catch (err) {
        throw new Error(`Не удалось удалить папку альбома на сервере: ${err.message}`);
      }
    } else if (album && deleteFromDisk && album.tracks && album.tracks.some(t => isRemotePath(t.filePath))) {
      for (const t of album.tracks) {
        try { await remoteStorage.remove(t.filePath); } catch (err) { console.warn('Error deleting remote track:', t.filePath, err.message); }
        this.tracks.delete(t.id);
      }
    } else if (album && deleteFromDisk) {
      if (album.folderPath && fs.existsSync(album.folderPath)) {
        try {
          if (Array.isArray(album.tracks)) {
            for (const t of album.tracks) {
              this.tracks.delete(t.id);
            }
          }
          fs.rmSync(album.folderPath, { recursive: true, force: true });
        } catch (err) {
          console.error('Error deleting album folder from disk:', album.folderPath, err);
          throw new Error(`Не удалось удалить папку альбома с диска: ${err.message}`);
        }
      } else if (Array.isArray(album.tracks)) {
        for (const t of album.tracks) {
          if (t.filePath && fs.existsSync(t.filePath)) {
            try {
              fs.unlinkSync(t.filePath);
            } catch (err) {
              console.warn('Error deleting track file:', t.filePath, err.message);
            }
          }
          this.tracks.delete(t.id);
        }
      }
    }

    const libraryConfig = this.configStore.get('library') || {};
    let albums = libraryConfig.albums || [];
    albums = albums.filter(a => a.id !== albumId);
    libraryConfig.albums = albums;
    this.configStore.set('library', libraryConfig);

    this.saveCache();
    await this.scanAllFolders();

    return this.getAlbums();
  }

  _discoverAlbumFolders(rootFolder, source = 'local') {
    const albumFolders = [];
    if (!rootFolder || !fs.existsSync(rootFolder)) return albumFolders;

    const visited = new Set();

    const scan = (currentDir, depth = 0) => {
      if (depth > 8) return;
      const norm = path.resolve(currentDir).toLowerCase();
      if (visited.has(norm)) return;
      visited.add(norm);

      let entries = [];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch (e) {
        return;
      }

      const directAudioFiles = [];
      const subDirs = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.')) {
            subDirs.push(path.join(currentDir, entry.name));
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (AUDIO_EXTENSIONS.has(ext)) {
            directAudioFiles.push(entry.name);
          }
        }
      }

      // Check if subdirectories are multi-disc folders (e.g. CD1, CD2, Disc 1)
      const isMultiDiscParent = subDirs.length > 0 && subDirs.every(sub => {
        const base = path.basename(sub).toLowerCase();
        return /^(cd|disc|disk)\s*\d+$/i.test(base);
      });

      if (isMultiDiscParent) {
        albumFolders.push({
          folderPath: currentDir,
          folderName: path.basename(currentDir),
          source
        });
        return;
      }

      // If current directory contains audio files directly
      if (directAudioFiles.length > 0) {
        const baseName = path.basename(currentDir).toLowerCase();
        if (!/^(cd|disc|disk)\s*\d+$/i.test(baseName)) {
          const isRootContainer = path.resolve(currentDir).toLowerCase() === path.resolve(rootFolder).toLowerCase();
          if (!isRootContainer) {
            albumFolders.push({
              folderPath: currentDir,
              folderName: path.basename(currentDir),
              source
            });
          }
        }
      }

      // Recurse into all subdirectories
      for (const sub of subDirs) {
        const base = path.basename(sub).toLowerCase();
        if (!/^(cd|disc|disk)\s*\d+$/i.test(base)) {
          scan(sub, depth + 1);
        }
      }
    };

    scan(rootFolder, 0);
    return albumFolders;
  }

  _findFolderCoverImage(folder) {
    const coverNames = [
      'cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp',
      'folder.jpg', 'folder.jpeg', 'folder.png',
      'front.jpg', 'front.jpeg', 'front.png',
      'album.jpg', 'album.png', 'artwork.jpg', 'artwork.png'
    ];
    try {
      for (const name of coverNames) {
        const p = path.join(folder, name);
        if (fs.existsSync(p)) return p;
      }
      // Also look case-insensitively in direct dir
      const files = fs.readdirSync(folder);
      for (const file of files) {
        const lower = file.toLowerCase();
        if (coverNames.includes(lower)) {
          return path.join(folder, file);
        }
      }
    } catch (e) {
      // ignore
    }
    return null;
  }

  _copyCoverArtToCache(identifier, sourcePath) {
    try {
      const ext = path.extname(sourcePath).toLowerCase() || '.jpg';
      const fileName = `custom_${identifier}_${Date.now()}${ext}`;
      const destPath = path.join(this.artCacheDir, fileName);
      fs.copyFileSync(sourcePath, destPath);
      return `atom://art/${fileName}`;
    } catch (e) {
      console.warn('Error copying cover art to cache:', e);
      return null;
    }
  }

  getPlaylists() {
    const libraryConfig = this.configStore.get('library') || {};
    const playlists = libraryConfig.playlists || [];
    const trackMap = this.tracks;
    const likedSet = new Set(libraryConfig.likedTrackIds || []);

    return playlists.map(pl => {
      const plTracks = (pl.trackIds || [])
        .map(id => trackMap.get(id))
        .filter(Boolean)
        .map(t => ({
          ...t,
          isLiked: likedSet.has(t.id)
        }));

      return {
        id: pl.id,
        name: pl.name,
        createdAt: pl.createdAt,
        tracksCount: plTracks.length,
        tracks: plTracks,
        coverArt: plTracks.find(t => t.coverArt)?.coverArt || null
      };
    });
  }

  createPlaylist(name, trackIds = []) {
    const trimmedName = (name && name.trim()) || 'Новый плейлист';
    const libraryConfig = this.configStore.get('library') || {};
    const playlists = libraryConfig.playlists || [];

    const newPlaylist = {
      id: 'pl_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      name: trimmedName,
      createdAt: Date.now(),
      trackIds: Array.isArray(trackIds) ? [...new Set(trackIds.map(String))] : []
    };

    playlists.push(newPlaylist);
    libraryConfig.playlists = playlists;
    this.configStore.set('library', libraryConfig);
    return this.getPlaylists();
  }

  deletePlaylist(playlistId) {
    const libraryConfig = this.configStore.get('library') || {};
    let playlists = libraryConfig.playlists || [];
    playlists = playlists.filter(p => p.id !== playlistId);
    libraryConfig.playlists = playlists;
    this.configStore.set('library', libraryConfig);
    return this.getPlaylists();
  }

  renamePlaylist(playlistId, newName) {
    const libraryConfig = this.configStore.get('library') || {};
    const playlists = libraryConfig.playlists || [];
    const target = playlists.find(p => p.id === playlistId);
    if (target) {
      target.name = (newName && newName.trim()) || target.name;
      libraryConfig.playlists = playlists;
      this.configStore.set('library', libraryConfig);
    }
    return this.getPlaylists();
  }

  addTrackToPlaylist(playlistId, trackId) {
    const libraryConfig = this.configStore.get('library') || {};
    const playlists = libraryConfig.playlists || [];
    const target = playlists.find(p => p.id === playlistId);
    if (target) {
      target.trackIds = target.trackIds || [];
      if (!target.trackIds.includes(trackId)) {
        target.trackIds.push(trackId);
        libraryConfig.playlists = playlists;
        this.configStore.set('library', libraryConfig);
      }
    }
    return this.getPlaylists();
  }

  // Replace the whole track list in one write (playlist editor)
  setPlaylistTracks(playlistId, trackIds) {
    const libraryConfig = this.configStore.get('library') || {};
    const playlists = libraryConfig.playlists || [];
    const target = playlists.find(p => p.id === playlistId);
    if (target && Array.isArray(trackIds)) {
      target.trackIds = [...new Set(trackIds.map(String))];
      libraryConfig.playlists = playlists;
      this.configStore.set('library', libraryConfig);
    }
    return this.getPlaylists();
  }

  removeTrackFromPlaylist(playlistId, trackId) {
    const libraryConfig = this.configStore.get('library') || {};
    const playlists = libraryConfig.playlists || [];
    const target = playlists.find(p => p.id === playlistId);
    if (target && target.trackIds) {
      target.trackIds = target.trackIds.filter(id => id !== trackId);
      libraryConfig.playlists = playlists;
      this.configStore.set('library', libraryConfig);
    }
    return this.getPlaylists();
  }

  async scanAllFolders(progressCallback) {
    const folderList = this._configuredRoots()
      .filter(root => this._rootExists(root))
      .map(root => ({ folderPath: root, source: 'local' }));

    if (folderList.length === 0) {
      this.tracks.clear();
      this.saveCache();
      return this.getTrackList();
    }

    const allFilePaths = [];
    const unreachableRoots = [];
    for (const { folderPath, source } of folderList) {
      if (isRemotePath(folderPath)) {
        try {
          progressCallback && progressCallback({ processed: 0, total: 0, currentFile: 'Чтение списка файлов на сервере…' });
          const { files, dirs } = await remoteStorage.walk(folderPath);
          for (const f of files) {
            if (AUDIO_EXTENSIONS.has(this._extname(f.url))) {
              allFilePaths.push({ filePath: f.url, source, baseFolder: folderPath, remote: { size: f.size, mtime: f.mtime } });
            }
          }
          await this._syncRemoteFolderCovers(folderPath, files, dirs);
        } catch (err) {
          // Keep the cached tracks of an unreachable server instead of wiping the library
          console.warn('Remote library scan failed:', err.message);
          unreachableRoots.push(this._key(folderPath));
          this.lastScanError = err.message;
        }
        continue;
      }
      const files = this._scanDirRecursively(folderPath);
      for (const f of files) {
        allFilePaths.push({ filePath: f, source, baseFolder: folderPath });
      }
    }

    const currentTrackIds = new Set();
    const totalFiles = allFilePaths.length;
    let processed = 0;
    if (unreachableRoots.length === 0) this.lastScanError = null;

    for (const item of allFilePaths) {
      processed++;
      const { filePath, source, baseFolder } = item;
      const trackId = this._generateTrackId(filePath);
      currentTrackIds.add(trackId);

      // Determine subfolder relative to baseFolder (if in a subfolder, that subfolder is the album!)
      const parts = item.remote
        ? (urlPath.relativeSegments(baseFolder, filePath) || [])
        : path.relative(baseFolder, filePath).split(path.sep);
      let subfolderAlbum = null;
      if (parts.length > 1) {
        subfolderAlbum = parts[0]; // The top-level subfolder inside musicFolder
      }

      try {
        const stat = item.remote
          ? { size: item.remote.size, mtimeMs: item.remote.mtime }
          : fs.statSync(filePath);
        const existingTrack = this.tracks.get(trackId);

        const needsRemoteReparse = item.remote && existingTrack && !existingTrack.coverArt &&
          existingTrack.remoteMetaVersion !== REMOTE_META_VERSION;
        if (existingTrack && !needsRemoteReparse && existingTrack.mtime === stat.mtimeMs && existingTrack.size === stat.size) {
          if (existingTrack.album === 'Яндекс Музыка' || existingTrack.album === 'Yandex Music') {
            existingTrack.source = 'yandex';
            existingTrack.album = subfolderAlbum || '';
          } else if (existingTrack.album === 'SoundCloud') {
            existingTrack.source = 'soundcloud';
            existingTrack.album = subfolderAlbum || '';
          } else if (!existingTrack.source || existingTrack.source === 'local') {
            existingTrack.source = source || 'local';
          }
          existingTrack.subfolderAlbum = subfolderAlbum;
          continue;
        }

        const metadata = item.remote
          ? await this._parseRemoteAudioFile(filePath, stat, source, trackId)
          : await this._parseAudioFile(filePath, stat, source, trackId);
        metadata.subfolderAlbum = subfolderAlbum;
        if (!metadata.album && subfolderAlbum) {
          metadata.album = subfolderAlbum;
        }
        this.tracks.set(trackId, metadata);
      } catch (err) {
        console.warn(`Failed to parse metadata for ${filePath}:`, err.message);
        const failedName = this._basename(filePath);
        this.tracks.set(trackId, {
          id: trackId,
          filePath,
          filename: failedName,
          title: failedName.replace(/\.[^.]+$/, ''),
          artist: 'Неизвестный исполнитель',
          album: subfolderAlbum || '',
          subfolderAlbum,
          year: null,
          genre: '',
          duration: 0,
          bitrate: 0,
          size: 0,
          mtime: 0,
          source: source || 'local',
          coverArt: null,
          trackNumber: null,
          discNumber: null
        });
      }

      if (progressCallback && (processed % 10 === 0 || processed === totalFiles)) {
        progressCallback({
          processed,
          total: totalFiles,
          currentFile: this._basename(filePath)
        });
      }
    }

    // Remove deleted files from tracks map
    const validRoots = folderList.map(f => this._key(f.folderPath));
    for (const [id, track] of this.tracks.entries()) {
      const trackKey = this._key(track.filePath);
      const remote = isRemotePath(track.filePath);
      // Tracks of a server that could not be reached are kept until it is back
      if (remote && unreachableRoots.some(root => this._isInside(root, trackKey))) continue;
      const inRoots = validRoots.some(root => this._isInside(root, trackKey));
      if (!inRoots || !currentTrackIds.has(id) || (!remote && !fs.existsSync(track.filePath))) {
        this.tracks.delete(id);
      }
    }

    this.saveCache();
    return this.getTrackList();
  }

  _scanDirRecursively(dir) {
    const results = [];
    try {
      const list = fs.readdirSync(dir, { withFileTypes: true });
      for (const dirent of list) {
        const fullPath = path.join(dir, dirent.name);
        if (dirent.isDirectory()) {
          results.push(...this._scanDirRecursively(fullPath));
        } else if (dirent.isFile()) {
          const ext = path.extname(dirent.name).toLowerCase();
          if (AUDIO_EXTENSIONS.has(ext)) {
            results.push(fullPath);
          }
        }
      }
    } catch (e) {
      console.warn(`Error reading dir ${dir}:`, e.message);
    }
    return results;
  }

  async _parseAudioFile(filePath, stat, source, trackId) {
    const filename = path.basename(filePath);
    const ext = path.extname(filePath);
    const defaultTitle = path.basename(filePath, ext);

    let mmData = null;
    try {
      mmData = await mm.parseFile(filePath, { duration: true, skipCovers: false });
    } catch (e) {
      // ignore, fallback below
    }

    return this._trackFromMetadata(mmData, { filePath, filename, defaultTitle, stat, source, trackId });
  }

  // Tags of a file on the WebDAV server. Only the beginning of the file is downloaded
  // (ID3v2 / FLAC / MP4 headers with cover art); the real file size lets music-metadata
  // compute the duration. Falls back to the full file when the header is not enough.
  async _parseRemoteAudioFile(url, stat, source, trackId) {
    const filename = urlPath.basename(url);
    const ext = urlPath.extname(url).toLowerCase();
    const defaultTitle = filename.replace(/\.[^.]+$/, '');
    const fileInfo = { mimeType: MIME_BY_EXT[ext] || 'audio/mpeg', size: stat.size || undefined, path: filename };

    let mmData = null;
    try {
      const HEAD_BYTES = 512 * 1024;
      let buf = await remoteStorage.readRange(url, 0, HEAD_BYTES - 1);
      // Embedded cover art can sit past the first chunk (big ID3v2 tag, FLAC PICTURE block
      // after padding): fetch exactly up to the end of the metadata
      const needed = await this._remoteMetadataLength(url, buf);
      if (needed > buf.length && needed < 64 * 1024 * 1024) {
        buf = await remoteStorage.readRange(url, 0, needed - 1);
      }
      mmData = await mm.parseBuffer(buf, fileInfo, { duration: false, skipCovers: false });
    } catch (e) {
      mmData = null;
    }

    const incomplete = !mmData || !mmData.format || !mmData.format.duration;
    if (incomplete && stat.size && stat.size < 150 * 1024 * 1024) {
      try {
        const full = await remoteStorage.readFile(url);
        mmData = await mm.parseBuffer(full, fileInfo, { duration: true, skipCovers: false });
      } catch (e) {
        // keep whatever we had
      }
    }

    const track = this._trackFromMetadata(mmData, { filePath: url, filename, defaultTitle, stat, source, trackId });
    track.remoteMetaVersion = REMOTE_META_VERSION;
    return track;
  }

  // Byte length of the leading metadata of a remote file (ID3v2 tag and/or FLAC metadata
  // blocks). Missing block headers beyond `head` are fetched with small Range requests.
  async _remoteMetadataLength(url, head) {
    const cache = new Map();
    const readAt = async (pos, len) => {
      if (pos + len <= head.length) return head.subarray(pos, pos + len);
      const key = `${pos}:${len}`;
      if (!cache.has(key)) cache.set(key, await remoteStorage.readRange(url, pos, pos + len - 1));
      return cache.get(key);
    };

    let offset = 0;
    const id3 = await readAt(0, 10);
    if (id3.length === 10 && id3.toString('latin1', 0, 3) === 'ID3') {
      const tagSize = ((id3[6] & 0x7f) << 21) | ((id3[7] & 0x7f) << 14) | ((id3[8] & 0x7f) << 7) | (id3[9] & 0x7f);
      offset = tagSize + 10 + ((id3[5] & 0x10) ? 10 : 0);
    }

    const magic = await readAt(offset, 4);
    if (magic.length === 4 && magic.toString('latin1') === 'fLaC') {
      let pos = offset + 4;
      for (let i = 0; i < 128; i++) {
        const h = await readAt(pos, 4);
        if (h.length < 4) break;
        const isLast = (h[0] & 0x80) !== 0;
        const len = (h[1] << 16) | (h[2] << 8) | h[3];
        pos += 4 + len;
        if (isLast) break;
      }
      offset = pos;
    }

    // A little audio after the metadata lets the parsers read the first frame
    return offset + 64 * 1024;
  }

  _trackFromMetadata(mmData, { filePath, filename, defaultTitle, stat, source, trackId }) {
    const common = mmData?.common || {};
    const format = mmData?.format || {};

    let coverArt = null;
    if (common.picture && common.picture.length > 0) {
      const pic = common.picture[0];
      const artExt = pic.format === 'image/png' ? '.png' : '.jpg';
      const artFileName = `${trackId}${artExt}`;
      const artFilePath = path.join(this.artCacheDir, artFileName);
      
      try {
        fs.writeFileSync(artFilePath, pic.data);
        coverArt = `atom://art/${artFileName}`;
      } catch (err) {
        coverArt = `data:${pic.format};base64,${pic.data.toString('base64')}`;
      }
    }

    const trackNumber = (common.track && typeof common.track.no === 'number') ? common.track.no : null;
    const discNumber = (common.disk && typeof common.disk.no === 'number') ? common.disk.no : null;

    // Detect track source (SoundCloud, Yandex Music, or Local)
    let detectedSource = source || 'local';
    const comments = Array.isArray(common.comment)
      ? common.comment.map(c => (typeof c === 'string' ? c : c.text || '')).join(' ')
      : String(common.comment || '');
    const genreStr = Array.isArray(common.genre) ? common.genre.join(' ') : String(common.genre || '');
    const encodedBy = String(common.encodedby || common.encoder || '');
    const rawAlbum = (common.album && common.album.trim()) || '';

    if (/soundcloud/i.test(comments) || /soundcloud/i.test(genreStr) || /soundcloud/i.test(encodedBy) || rawAlbum === 'SoundCloud') {
      detectedSource = 'soundcloud';
    } else if (/yandex/i.test(comments) || /яндекс/i.test(comments) || /yandex/i.test(genreStr) || /яндекс/i.test(genreStr) || /yandex/i.test(encodedBy) || rawAlbum === 'Яндекс Музыка' || rawAlbum === 'Yandex Music') {
      detectedSource = 'yandex';
    }

    // Clean album so platform name placeholder is not shown as an Album
    let cleanAlbum = rawAlbum;
    if (cleanAlbum === 'SoundCloud' || cleanAlbum === 'Яндекс Музыка' || cleanAlbum === 'Yandex Music' || cleanAlbum === 'Неизвестный альбом') {
      cleanAlbum = '';
    }

    return {
      id: trackId,
      filePath,
      filename,
      title: (common.title && common.title.trim()) || defaultTitle,
      artist: (common.artist && common.artist.trim()) || 'Неизвестный исполнитель',
      album: cleanAlbum,
      year: common.year || null,
      genre: (common.genre && common.genre[0]) || '',
      duration: Math.round(format.duration || 0),
      bitrate: Math.round((format.bitrate || 0) / 1000),
      size: stat.size,
      mtime: stat.mtimeMs,
      source: detectedSource,
      coverArt,
      trackNumber,
      discNumber
    };
  }

  _generateTrackId(filePath) {
    return crypto.createHash('md5').update(filePath.toLowerCase()).digest('hex');
  }

  // Look up artwork online (Deezer, iTunes) for albums and tracks that have no cover in the files
  // or folder. Found covers are stored in the art cache only — audio files are not modified.
  // onProgress({ done, total, found }) is called along the way.
  async fetchMissingCovers(onProgress) {
    if (this.coverSearchRunning) return { skipped: true };
    this.coverSearchRunning = true;
    let found = 0;
    try {
      const albums = this.getAlbums().filter(a => !a.coverArt && a.tracks && a.tracks.length);
      const albumTrackIds = new Set();
      albums.forEach(a => a.tracks.forEach(t => albumTrackIds.add(t.id)));

      const loneTracks = Array.from(this.tracks.values())
        .filter(t => !t.coverArt && !albumTrackIds.has(t.id));
      const total = albums.length + loneTracks.length;
      let done = 0;
      let changed = false;
      const report = () => onProgress && onProgress({ done, total, found });

      // 1. Albums: one lookup per album, the cover goes to every track of it that has none
      for (const album of albums) {
        const cover = await this.coverFinder.find({ kind: 'album', artist: album.artist, name: album.title });
        if (cover) {
          found++;
          for (const t of album.tracks) {
            const track = this.tracks.get(t.id);
            if (track && !track.coverArt) {
              track.coverArt = cover;
              track.coverSource = 'online';
              changed = true;
            }
          }
        }
        done++;
        report();
      }

      // 2. Tracks outside albums: by their album tag if they have one, otherwise by title
      for (const t of loneTracks) {
        const track = this.tracks.get(t.id);
        if (!track || track.coverArt) { done++; continue; }
        let cover = null;
        if (track.album) cover = await this.coverFinder.find({ kind: 'album', artist: track.artist, name: track.album });
        if (!cover) cover = await this.coverFinder.find({ kind: 'track', artist: track.artist, name: track.title });
        if (cover) {
          found++;
          track.coverArt = cover;
          track.coverSource = 'online';
          changed = true;
        }
        done++;
        report();
      }

      if (changed) this.saveCache();
      return { total, found, changed };
    } finally {
      this.coverSearchRunning = false;
    }
  }

  // Album folders on the server, derived from the scanned track URLs with the same rules
  // as _discoverAlbumFolders: a folder with audio files is an album (except the root),
  // CD1/Disc 2 subfolders are merged into their parent.
  _discoverRemoteAlbumFolders(rootUrl, allTracks, source = 'local') {
    const rootKey = canonicalUrl(rootUrl);
    const folders = new Map();
    for (const t of allTracks) {
      if (!isRemotePath(t.filePath) || !urlPath.isInside(rootKey, t.filePath)) continue;
      let dir = urlPath.dirname(t.filePath);
      if (DISC_FOLDER_RE.test(urlPath.basename(dir))) dir = urlPath.dirname(dir);
      if (dir === rootKey || !urlPath.isInside(rootKey, dir)) continue;
      if (!folders.has(dir)) folders.set(dir, { folderPath: dir, folderName: urlPath.basename(dir), source });
    }
    return Array.from(folders.values());
  }

  // Download folder cover images (cover.jpg, folder.png ...) found on the server into the art cache
  async _syncRemoteFolderCovers(rootUrl, files) {
    const byDir = new Map();
    for (const f of files) {
      const lower = f.name.toLowerCase();
      if (!COVER_FILE_NAMES.includes(lower)) continue;
      const dir = canonicalUrl(f.parent);
      const prev = byDir.get(dir);
      if (!prev || COVER_FILE_NAMES.indexOf(lower) < COVER_FILE_NAMES.indexOf(prev.name.toLowerCase())) byDir.set(dir, f);
    }

    let changed = false;
    for (const [dir, file] of byDir) {
      const albumId = 'album_' + crypto.createHash('md5').update(dir).digest('hex');
      const signature = `${file.size}_${file.mtime}`;
      if (this.remoteFolderCovers[dir] && this.remoteFolderCovers[dir + '#sig'] === signature) continue;
      try {
        const data = await remoteStorage.readFile(file.url);
        const ext = path.extname(file.name).toLowerCase() || '.jpg';
        // Signature in the file name so a changed cover is not served from the image cache
        const fileName = `remote_${albumId}_${signature}${ext}`;
        fs.writeFileSync(path.join(this.artCacheDir, fileName), data);
        this.remoteFolderCovers[dir] = `atom://art/${fileName}`;
        this.remoteFolderCovers[dir + '#sig'] = signature;
        changed = true;
      } catch (e) {
        console.warn('Cannot download remote cover:', file.url, e.message);
      }
    }
    if (changed) this.saveRemoteCovers();
  }

  // Upload every file of a local folder (e.g. a finished download) to a remote folder,
  // keeping the relative structure. Returns the list of uploaded URLs.
  async uploadLocalFolderToRemote(localDir, remoteRoot) {
    const uploaded = [];
    const walk = async (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          const rel = path.relative(localDir, full).split(path.sep);
          const targetUrl = urlPath.join(remoteRoot, ...rel);
          await remoteStorage.mkdirp(urlPath.dirname(targetUrl));
          await remoteStorage.writeFile(targetUrl, fs.readFileSync(full));
          uploaded.push(targetUrl);
        }
      }
    };
    await walk(localDir);
    return uploaded;
  }
}

module.exports = LibraryManager;
