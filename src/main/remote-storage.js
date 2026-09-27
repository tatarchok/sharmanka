// Remote music storage over WebDAV (HTTP).
// Lets the library use a folder like http://192.168.0.14:8080/music exactly like a local folder:
// list files, read tags (via HTTP Range), stream for playback, upload downloads, delete files/albums.
const { safeStorage } = require('electron');

const REQUEST_TIMEOUT_MS = 20000;

function isRemotePath(p) {
  return typeof p === 'string' && /^https?:\/\//i.test(p.trim());
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

// One canonical form for every remote URL (servers differ in how they percent-encode hrefs)
function canonicalUrl(input, { dir = false } = {}) {
  const u = new URL(input);
  const segments = u.pathname.split('/').map(seg => encodeURIComponent(safeDecode(seg)));
  let pathname = segments.join('/').replace(/\/+/g, '/');
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  if (dir && !pathname.endsWith('/')) pathname += '/';
  return `${u.protocol}//${u.host}${pathname || '/'}`;
}

// URL-aware counterparts of path.* used by the library
const urlPath = {
  basename(url) {
    const parts = new URL(url).pathname.replace(/\/+$/, '').split('/');
    return safeDecode(parts[parts.length - 1] || '');
  },
  extname(url) {
    const base = urlPath.basename(url);
    const i = base.lastIndexOf('.');
    return i > 0 ? base.slice(i) : '';
  },
  dirname(url) {
    const u = new URL(url);
    const parts = u.pathname.replace(/\/+$/, '').split('/');
    parts.pop();
    return canonicalUrl(`${u.protocol}//${u.host}${parts.join('/') || '/'}`);
  },
  join(base, ...names) {
    let url = canonicalUrl(base, { dir: true });
    for (const name of names) {
      String(name).split(/[\\/]+/).filter(Boolean).forEach(seg => {
        url = canonicalUrl(url, { dir: true }) + encodeURIComponent(seg);
      });
    }
    return canonicalUrl(url);
  },
  // Relative path segments (decoded) of child inside root, or null if not inside
  relativeSegments(root, child) {
    const r = canonicalUrl(root);
    const c = canonicalUrl(child);
    if (c === r) return [];
    if (!c.startsWith(r + '/') && !(r.endsWith('/') && c.startsWith(r))) return null;
    return c.slice(r.endsWith('/') ? r.length : r.length + 1).split('/').map(safeDecode);
  },
  isInside(root, child) {
    return urlPath.relativeSegments(root, child) !== null;
  }
};

function decodeXml(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

// Tolerant PROPFIND multistatus parser (namespace prefixes differ between servers)
function parseMultistatus(xml, requestUrl) {
  const entries = [];
  const blocks = xml.split(/<(?:[\w-]+:)?response[\s>]/i).slice(1);
  for (const block of blocks) {
    const hrefMatch = block.match(/<(?:[\w-]+:)?href[^>]*>([^<]*)<\/(?:[\w-]+:)?href>/i);
    if (!hrefMatch) continue;
    const href = decodeXml(hrefMatch[1].trim());
    // rclone / Go x/net/webdav write <D:collection xmlns:D="DAV:"/> — allow attributes
    const isDir = /<(?:[\w-]+:)?collection\b[^>]*>/i.test(block) || /\/$/.test(hrefMatch[1].trim());
    const sizeMatch = block.match(/<(?:[\w-]+:)?getcontentlength[^>]*>(\d+)</i);
    const mtimeMatch = block.match(/<(?:[\w-]+:)?getlastmodified[^>]*>([^<]+)</i);
    let url;
    try { url = canonicalUrl(new URL(href, requestUrl).href); } catch (e) { continue; }
    entries.push({
      url,
      name: urlPath.basename(url),
      isDir,
      size: sizeMatch ? Number(sizeMatch[1]) : 0,
      mtime: mtimeMatch ? (Date.parse(mtimeMatch[1]) || 0) : 0
    });
  }
  return entries;
}

class RemoteStorage {
  constructor() {
    this.rootUrl = '';
    this.username = '';
    this.password = '';
  }

  // ---- configuration -------------------------------------------------------
  configure(remoteCfg) {
    const cfg = remoteCfg || {};
    this.rootUrl = cfg.url ? canonicalUrl(cfg.url) : '';
    this.username = cfg.username || '';
    this.password = RemoteStorage.decryptPassword(cfg.password);
  }

  static encryptPassword(plain) {
    if (!plain) return '';
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return 'enc:' + safeStorage.encryptString(plain).toString('base64');
      }
    } catch (e) {}
    return 'plain:' + Buffer.from(plain, 'utf8').toString('base64');
  }

  static decryptPassword(stored) {
    if (!stored) return '';
    try {
      if (stored.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
      if (stored.startsWith('plain:')) return Buffer.from(stored.slice(6), 'base64').toString('utf8');
    } catch (e) {}
    return '';
  }

  isConfigured() {
    return !!this.rootUrl;
  }

  get origin() {
    try { return this.rootUrl ? new URL(this.rootUrl).origin : ''; } catch (e) { return ''; }
  }

  // Authorization header for requests to our server (used for playback in the renderer too)
  authHeaderFor(url) {
    if (!this.username || !this.origin || typeof url !== 'string' || !url.startsWith(this.origin)) return null;
    return 'Basic ' + Buffer.from(`${this.username}:${this.password}`, 'utf8').toString('base64');
  }

  // ---- HTTP helpers --------------------------------------------------------
  async request(url, { method = 'GET', headers = {}, body, timeout = REQUEST_TIMEOUT_MS, auth } = {}) {
    const h = { ...headers };
    const credentials = auth || (this.username ? { username: this.username, password: this.password } : null);
    if (credentials && credentials.username) {
      h.Authorization = 'Basic ' + Buffer.from(`${credentials.username}:${credentials.password || ''}`, 'utf8').toString('base64');
    }
    const init = { method, headers: h, body };
    if (timeout) init.signal = AbortSignal.timeout(timeout);
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      const code = (e && e.cause && (e.cause.code || (e.cause.errors && e.cause.errors[0] && e.cause.errors[0].code))) || '';
      const reasons = {
        ECONNREFUSED: 'порт закрыт — сервер не запущен или указан неверный порт',
        EHOSTUNREACH: 'сервер недоступен в сети',
        ENETUNREACH: 'сеть недоступна',
        ETIMEDOUT: 'сервер не ответил вовремя',
        ENOTFOUND: 'адрес сервера не найден'
      };
      const reason = e && e.name === 'TimeoutError' ? 'сервер не ответил вовремя' : (reasons[code] || code || e.message);
      throw new Error(`Нет связи с сервером: ${reason}`);
    }
    if (res.status === 401) throw new Error('Неверный логин или пароль для сетевого хранилища');
    if (res.status === 403) throw new Error('Доступ запрещён (403). Проверьте права папки на сервере');
    return res;
  }

  async propfind(url, depth = 1, auth) {
    const res = await this.request(canonicalUrl(url, { dir: true }), {
      method: 'PROPFIND',
      headers: { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' },
      body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>',
      auth
    });
    if (res.status === 404) throw new Error('Папка не найдена на сервере (404)');
    if (res.status === 405 || res.status === 501) throw new Error('Сервер не поддерживает WebDAV (PROPFIND). Проверьте адрес и порт');
    if (res.status !== 207 && !res.ok) throw new Error(`Ошибка сервера: HTTP ${res.status}`);
    const xml = await res.text();
    return parseMultistatus(xml, url);
  }

  // Direct children of a folder (without the folder itself)
  async list(url) {
    const self = canonicalUrl(url);
    const entries = await this.propfind(url, 1);
    return entries.filter(e => canonicalUrl(e.url) !== self);
  }

  // Recursive listing: { files: [...], dirs: [...] }
  async walk(rootUrl, { maxDepth = 12, concurrency = 4 } = {}) {
    const files = [];
    const dirs = [];
    const queue = [{ url: canonicalUrl(rootUrl), depth: 0 }];
    const seen = new Set();

    const worker = async () => {
      while (queue.length) {
        const { url, depth } = queue.shift();
        if (seen.has(url)) continue;
        seen.add(url);
        let children;
        try {
          children = await this.list(url);
        } catch (e) {
          if (depth === 0) throw e;
          console.warn('[RemoteStorage] Cannot list', url, e.message);
          continue;
        }
        for (const child of children) {
          if (child.isDir) {
            if (child.name.startsWith('.')) continue;
            dirs.push({ ...child, parent: url });
            if (depth < maxDepth) queue.push({ url: child.url, depth: depth + 1 });
          } else {
            files.push({ ...child, parent: url });
          }
        }
      }
    };

    // Simple pool: keep workers alive while the queue refills
    let active = 0;
    await new Promise((resolve, reject) => {
      const spawn = () => {
        while (active < concurrency && queue.length) {
          active++;
          worker().then(() => {
            active--;
            if (queue.length) spawn();
            else if (active === 0) resolve();
          }, reject);
        }
        if (active === 0 && !queue.length) resolve();
      };
      spawn();
    });

    return { files, dirs };
  }

  async readRange(url, start, end) {
    const res = await this.request(url, { headers: { Range: `bytes=${start}-${end}` } });
    if (res.status === 404) throw new Error('Файл не найден на сервере');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (res.status === 206) return Buffer.from(await res.arrayBuffer());

    // Server ignored Range: read only what we need and stop the transfer
    const wanted = end - start + 1;
    const chunks = [];
    let total = 0;
    const reader = res.body.getReader();
    while (total < wanted + start) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      total += value.length;
    }
    try { await reader.cancel(); } catch (e) {}
    return Buffer.concat(chunks).subarray(start, start + wanted);
  }

  async readFile(url) {
    const res = await this.request(url, { timeout: 0 });
    if (res.status === 404) throw new Error('Файл не найден на сервере');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async writeFile(url, buffer) {
    const res = await this.request(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buffer.length) },
      body: buffer,
      timeout: 0
    });
    if (!res.ok) throw new Error(`Не удалось загрузить файл на сервер: HTTP ${res.status}`);
  }

  async mkdirp(dirUrl) {
    const target = canonicalUrl(dirUrl);
    const root = this.rootUrl && urlPath.isInside(this.rootUrl, target) ? this.rootUrl : `${new URL(target).origin}/`;
    const segments = urlPath.relativeSegments(root, target) || [];
    let current = canonicalUrl(root);
    for (const seg of segments) {
      current = urlPath.join(current, seg);
      const res = await this.request(canonicalUrl(current, { dir: true }), { method: 'MKCOL' });
      // 201 created, 405 already exists
      if (!res.ok && res.status !== 405 && res.status !== 301) {
        throw new Error(`Не удалось создать папку на сервере: HTTP ${res.status}`);
      }
    }
  }

  async remove(url, { isDir = false } = {}) {
    const res = await this.request(canonicalUrl(url, { dir: isDir }), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`Не удалось удалить на сервере: HTTP ${res.status}`);
  }

  // Connection test used by Settings: checks auth, WebDAV support and write access
  async test({ url, username, password }) {
    const root = canonicalUrl(url);
    const auth = { username: username || '', password: password || '' };
    const entries = await this.propfind(root, 1, auth);
    const self = entries.find(e => canonicalUrl(e.url) === root);
    if (self && !self.isDir) throw new Error('Указанный адрес — это файл, а не папка');
    const children = entries.filter(e => canonicalUrl(e.url) !== root);
    return {
      success: true,
      folders: children.filter(e => e.isDir).length,
      files: children.filter(e => !e.isDir).length
    };
  }
}

const remoteStorage = new RemoteStorage();

module.exports = { remoteStorage, RemoteStorage, isRemotePath, canonicalUrl, urlPath };
