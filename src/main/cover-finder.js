// Online artwork lookup for albums/tracks that have no embedded or folder cover.
// Sources (no API keys needed): Deezer search API, then the iTunes Search API.
// Results (including "not found") are cached on disk so each item is looked up only once.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REQUEST_TIMEOUT_MS = 10000;
const MIN_INTERVAL_MS = 250; // stay well under Deezer's 50 requests / 5 s
const NOT_FOUND_RETRY_MS = 14 * 24 * 60 * 60 * 1000;

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s*[\(\[][^\)\]]*[\)\]]/g, ' ')       // (feat. ...), [Deluxe] ...
    .replace(/\b(feat|ft|prod|with)\b\.?.*$/i, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function firstArtist(artist) {
  return String(artist || '').split(/\s*(?:,|&|;|\bfeat\.?|\bft\.|\bx\b)\s*/i)[0].trim();
}

// Loose similarity: equal, or one contains the other (after normalization)
function similar(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

class CoverFinder {
  constructor(userDataPath, artCacheDir) {
    this.artCacheDir = artCacheDir;
    this.cachePath = path.join(userDataPath, 'online-covers.json');
    this.cache = {};
    this.lastRequestAt = 0;
    try {
      if (fs.existsSync(this.cachePath)) this.cache = JSON.parse(fs.readFileSync(this.cachePath, 'utf8')) || {};
    } catch (e) {}
  }

  save() {
    try { fs.writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2), 'utf8'); } catch (e) {}
  }

  static albumKey(artist, album) {
    return `album|${normalize(firstArtist(artist))}|${normalize(album)}`;
  }

  static trackKey(artist, title) {
    return `track|${normalize(firstArtist(artist))}|${normalize(title)}`;
  }

  // Cached cover URL (atom://...) or null; undefined = not looked up yet (or retry is due)
  getCached(key) {
    const entry = this.cache[key];
    if (!entry) return undefined;
    if (entry.cover) {
      const file = entry.cover.replace(/^atom:\/\/art\//, '');
      if (fs.existsSync(path.join(this.artCacheDir, file))) return entry.cover;
      return undefined;
    }
    if (Date.now() - (entry.checkedAt || 0) > NOT_FOUND_RETRY_MS) return undefined;
    return null;
  }

  async throttle() {
    const wait = this.lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }

  async getJson(url) {
    await this.throttle();
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { 'User-Agent': 'Sharmanka/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // ---- sources -------------------------------------------------------------
  // Deezer may return cover_xl = null for region-restricted releases while still giving the
  // image hash (md5_image); the CDN serves the picture by that hash.
  static deezerCover(obj) {
    if (!obj) return null;
    if (obj.cover_xl || obj.cover_big) return obj.cover_xl || obj.cover_big;
    if (obj.md5_image) return `https://cdn-images.dzcdn.net/images/cover/${obj.md5_image}/1000x1000-000000-80-0-0.jpg`;
    return null;
  }

  async deezerSearch(type, artist, name, pickName, pickCoverObj) {
    const field = type === 'album' ? 'album' : 'track';
    const queries = [
      `artist:"${firstArtist(artist)}" ${field}:"${name}"`,
      `${firstArtist(artist)} ${name}` // free text catches transliterated artist names (ЛСП → LSP)
    ];
    for (const q of queries) {
      const data = await this.getJson(`https://api.deezer.com/search/${type}?limit=15&q=${encodeURIComponent(q)}`);
      const list = data.data || [];
      // Strict query: Deezer already filtered by artist. Free text: require the artist too,
      // unless the result list is tiny (transliterated names like ЛСП → LSP won't compare equal)
      const strict = q === queries[0];
      for (const item of list) {
        if (!similar(pickName(item), name)) continue;
        if (strict || similar(item.artist && item.artist.name, firstArtist(artist)) || list.length <= 3) {
          const cover = CoverFinder.deezerCover(pickCoverObj(item));
          if (cover) return cover;
        }
      }
    }
    return null;
  }

  deezerAlbum(artist, album) {
    return this.deezerSearch('album', artist, album, a => a.title, a => a);
  }

  deezerTrack(artist, title) {
    return this.deezerSearch('track', artist, title, t => t.title, t => t.album);
  }

  async itunes(entity, artist, name) {
    const term = `${firstArtist(artist)} ${name}`;
    const data = await this.getJson(`https://itunes.apple.com/search?media=music&entity=${entity}&limit=10&term=${encodeURIComponent(term)}`);
    const field = entity === 'album' ? 'collectionName' : 'trackName';
    const hit = (data.results || []).find(r => similar(r.artistName, firstArtist(artist)) && similar(r[field], name));
    return hit && hit.artworkUrl100 ? hit.artworkUrl100.replace(/\/\d+x\d+bb\./, '/600x600bb.') : null;
  }

  async download(imageUrl, key) {
    const res = await fetch(imageUrl, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    const ext = type.includes('png') ? '.png' : '.jpg';
    const fileName = `online_${crypto.createHash('md5').update(key).digest('hex')}${ext}`;
    fs.writeFileSync(path.join(this.artCacheDir, fileName), Buffer.from(await res.arrayBuffer()));
    return `atom://art/${fileName}`;
  }

  // ---- public API ----------------------------------------------------------
  async find({ kind, artist, name }) {
    if (!name || !artist || /неизвестный исполнитель/i.test(artist)) return null;
    const key = kind === 'album' ? CoverFinder.albumKey(artist, name) : CoverFinder.trackKey(artist, name);
    const cached = this.getCached(key);
    if (cached !== undefined) return cached;

    let imageUrl = null;
    const attempts = kind === 'album'
      ? [() => this.deezerAlbum(artist, name), () => this.itunes('album', artist, name)]
      : [() => this.deezerTrack(artist, name), () => this.itunes('song', artist, name)];
    let networkError = false;
    for (const attempt of attempts) {
      try {
        imageUrl = await attempt();
        if (imageUrl) break;
      } catch (e) {
        networkError = true;
      }
    }

    let cover = null;
    if (imageUrl) {
      try { cover = await this.download(imageUrl, key); } catch (e) { networkError = true; }
    }
    // Don't remember "not found" when the services were simply unreachable
    if (cover || !networkError) {
      this.cache[key] = { cover, source: imageUrl || null, checkedAt: Date.now() };
      this.save();
    }
    return cover;
  }
}

module.exports = { CoverFinder };
