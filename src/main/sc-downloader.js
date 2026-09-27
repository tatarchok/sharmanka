const fs = require('fs');
const path = require('path');
const fetch = require('cross-fetch');
let NodeID3 = null;
try {
  NodeID3 = require('node-id3');
} catch (e) {
  // Will be loaded when module installs
}

class SoundCloudDownloader {
  constructor() {
    this.session = null;
    this.capturedClientId = null;
    this.cachedClientId = null;
    this.resolvingClientPromise = null;
  }

  setSession(session) {
    this.session = session;
  }

  // All requests go through the SoundCloud session, so its proxy applies to downloads too
  http(url, options = {}) {
    if (this.session && typeof this.session.fetch === 'function') {
      return this.session.fetch(url, options);
    }
    return fetch(url, options);
  }

  setCapturedClientId(clientId) {
    if (clientId && typeof clientId === 'string' && clientId.length >= 10) {
      this.capturedClientId = clientId;
      this.cachedClientId = clientId;
    }
  }

  async getClientId() {
    if (this.capturedClientId) return this.capturedClientId;
    if (this.cachedClientId) return this.cachedClientId;

    if (this.resolvingClientPromise) {
      return this.resolvingClientPromise;
    }

    this.resolvingClientPromise = (async () => {
      try {
        // Fetch SoundCloud homepage to extract client_id from script assets
        const res = await this.http('https://soundcloud.com', {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
          }
        });
        const html = await res.text();
        
        // Find JS asset URLs
        const scriptUrls = [];
        const scriptRegex = /<script[^>]+src=["'](https:\/\/[^"']+\.js)["']/g;
        let match;
        while ((match = scriptRegex.exec(html)) !== null) {
          if (match[1] && (match[1].includes('sndcdn.com') || match[1].includes('assets/'))) {
            scriptUrls.push(match[1]);
          }
        }

        // Search scripts in reverse order (app script is usually near the end)
        for (let i = scriptUrls.length - 1; i >= 0; i--) {
          try {
            const jsRes = await this.http(scriptUrls[i]);
            const jsCode = await jsRes.text();
            const idMatch = jsCode.match(/client_id[:=]["']([a-zA-Z0-9]{32})["']/);
            if (idMatch && idMatch[1]) {
              this.cachedClientId = idMatch[1];
              return this.cachedClientId;
            }
          } catch (err) {}
        }
      } catch (e) {
        console.warn('Failed to dynamically resolve SoundCloud clientId:', e.message);
      } finally {
        this.resolvingClientPromise = null;
      }

      // Modern default fallback client_id if extraction fails
      return this.capturedClientId || 'Pb72ranhoyt6gw7hM7TkzUItXlMWSNSo';
    })();

    return this.resolvingClientPromise;
  }

  async resolve(trackUrlOrId) {
    if (trackUrlOrId && typeof trackUrlOrId === 'object') {
      if (trackUrlOrId.transcodings || trackUrlOrId.tracks) {
        return trackUrlOrId;
      }
      const u = trackUrlOrId.permalink || trackUrlOrId.permalinkUrl || trackUrlOrId.url || trackUrlOrId.id;
      if (u) return await this.resolve(u);
    }

    let input = String(trackUrlOrId || '').trim();
    if (!input || input === '[object Object]') {
      throw new Error('Укажите ссылку на трек или альбом SoundCloud');
    }

    // 1. Resolve short links (on.soundcloud.com, m.soundcloud.com)
    if (input.includes('on.soundcloud.com') || input.includes('m.soundcloud.com')) {
      try {
        const headRes = await this.http(input, {
          method: 'GET',
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
          }
        });
        if (headRes.url && headRes.url !== input) {
          input = headRes.url;
        }
      } catch(e) {}
    }

    // 2. Strip tracking query params like ?si=..., ?in=... for single track resolve
    let cleanUrl = input;
    if (cleanUrl.startsWith('http')) {
      try {
        const u = new URL(cleanUrl);
        const secretToken = u.searchParams.get('secret_token');
        u.search = secretToken ? `?secret_token=${secretToken}` : '';
        cleanUrl = u.toString();
      } catch(e) {}
    }

    // 3. Try resolving via api-v2.soundcloud.com/resolve
    let data = null;
    let clientId = await this.getClientId();

    try {
      const apiUrl = /^\d+$/.test(input) 
        ? `https://api-v2.soundcloud.com/tracks/${input}?client_id=${clientId}`
        : `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(cleanUrl)}&client_id=${clientId}`;

      const res = await this.http(apiUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
        }
      });

      if (res.ok) {
        data = await res.json();
      } else if (res.status === 401 || res.status === 403) {
        this.cachedClientId = null;
        clientId = await this.getClientId();
        const retryUrl = /^\d+$/.test(input)
          ? `https://api-v2.soundcloud.com/tracks/${input}?client_id=${clientId}`
          : `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(cleanUrl)}&client_id=${clientId}`;
        const retryRes = await this.http(retryUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
          }
        });
        if (retryRes.ok) {
          data = await retryRes.json();
        }
      }
    } catch (e) {
      console.warn('API resolve error:', e.message);
    }

    // 4. If data has no media transcodings or resolve failed, try HTML hydration scraping
    if (!data || (!data.media?.transcodings?.length && data.kind !== 'playlist')) {
      if (cleanUrl.startsWith('http')) {
        try {
          const pageRes = await this.http(cleanUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
            }
          });
          if (pageRes.ok) {
            const html = await pageRes.text();
            const hydMatch = html.match(/<script>window\.__sc_hydration\s*=\s*(\[.*?\]);<\/script>/);
            if (hydMatch && hydMatch[1]) {
              const hyd = JSON.parse(hydMatch[1]);
              for (const item of hyd) {
                if (item.hydratable === 'sound' && item.data) {
                  data = item.data;
                  break;
                } else if (item.data?.media?.transcodings?.length) {
                  data = item.data;
                  break;
                } else if (item.hydratable === 'playlist' && item.data) {
                  data = item.data;
                  break;
                }
              }
            }
          }
        } catch(e) {
          console.warn('HTML hydration scrape error:', e.message);
        }
      }
    }

    // 5. If data has an ID but no transcodings, try api-v2.soundcloud.com/tracks/{id}
    if (data && data.id && (!data.media || !data.media.transcodings || data.media.transcodings.length === 0) && data.kind !== 'playlist') {
      try {
        const cid = await this.getClientId();
        const trackRes = await this.http(`https://api-v2.soundcloud.com/tracks/${data.id}?client_id=${cid}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
          }
        });
        if (trackRes.ok) {
          const trackJson = await trackRes.json();
          if (trackJson && trackJson.media?.transcodings?.length) {
            data = trackJson;
          }
        }
      } catch(e) {}
    }

    if (!data) {
      throw new Error('Не удалось получить данные трека SoundCloud. Проверьте правильность ссылки.');
    }
    if (data.kind === 'user') {
      throw new Error('Это ссылка на профиль исполнителя, а не на трек или альбом SoundCloud.');
    }

    let artwork = data.artwork_url || (data.user && data.user.avatar_url) || null;
    if (artwork && typeof artwork === 'string') {
      artwork = artwork.replace('-large.', '-t500x500.');
    }

    let releaseYear = null;
    if (data.release_date) {
      releaseYear = new Date(data.release_date).getFullYear();
    } else if (data.created_at) {
      releaseYear = new Date(data.created_at).getFullYear();
    }

    if (data.kind === 'playlist' || Array.isArray(data.tracks)) {
      return {
        kind: 'playlist',
        id: data.id,
        title: (data.title || 'SoundCloud Album').trim(),
        artist: (data.user && data.user.username ? data.user.username : 'SoundCloud Artist').trim(),
        year: releaseYear ? String(releaseYear) : String(new Date().getFullYear()),
        genre: data.genre || '',
        artworkUrl: artwork,
        permalinkUrl: data.permalink_url || input,
        tracks: data.tracks || [],
        tracksCount: data.track_count || (data.tracks ? data.tracks.length : 0)
      };
    }

    if (!data.media || !data.media.transcodings || data.media.transcodings.length === 0) {
      throw new Error('SoundCloud не предоставил доступные аудиопотоки для этого трека (возможно, трек ограничен автором или регионом).');
    }

    return {
      kind: 'track',
      id: data.id,
      title: (data.title || 'SoundCloud Track').trim(),
      artist: (data.user && data.user.username ? data.user.username : 'SoundCloud Artist').trim(),
      album: '',
      duration: Math.round((data.duration || 0) / 1000),
      genre: data.genre || '',
      year: releaseYear ? String(releaseYear) : String(new Date().getFullYear()),
      artworkUrl: artwork,
      permalinkUrl: data.permalink_url || input,
      transcodings: data.media.transcodings || []
    };
  }

  async resolveTrack(trackUrlOrId) {
    const res = await this.resolve(trackUrlOrId);
    if (res.kind === 'playlist') {
      throw new Error('Указанная ссылка ведёт на альбом/плейлист. Используйте метод download.');
    }
    return res;
  }

  async fetchStreamUrl(transcodingUrl) {
    let clientId = await this.getClientId();
    let url = transcodingUrl.includes('?') 
      ? `${transcodingUrl}&client_id=${clientId}` 
      : `${transcodingUrl}?client_id=${clientId}`;

    let res = await this.http(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
      }
    });

    if (!res.ok) {
      this.cachedClientId = null;
      clientId = await this.getClientId();
      url = transcodingUrl.includes('?') 
        ? `${transcodingUrl}&client_id=${clientId}` 
        : `${transcodingUrl}?client_id=${clientId}`;
      res = await this.http(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
        }
      });
    }

    if (!res.ok) {
      throw new Error(`Не удалось авторизовать аудиопоток (${res.status})`);
    }

    const data = await res.json();
    return data.url;
  }

  async downloadBuffer(url, onProgress = null) {
    const res = await this.http(url);
    if (!res.ok) {
      throw new Error(`HTTP error ${res.status} downloading stream`);
    }
    const totalLength = parseInt(res.headers.get('content-length') || '0', 10);
    if (!res.body || !onProgress || !totalLength) {
      return Buffer.from(await res.arrayBuffer());
    }
    const reader = res.body.getReader();
    const chunks = [];
    let downloaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      downloaded += value.length;
      onProgress(Math.round((downloaded / totalLength) * 100));
    }
    return Buffer.concat(chunks);
  }

  async downloadHlsStream(m3u8Url, onProgress = null) {
    const res = await this.http(m3u8Url);
    if (!res.ok) throw new Error('Не удалось загрузить HLS плейлист трека');
    const playlistText = await res.text();

    const segmentUrls = [];
    const lines = playlistText.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        if (trimmed.startsWith('http')) {
          segmentUrls.push(trimmed);
        } else {
          const base = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
          segmentUrls.push(base + trimmed);
        }
      }
    }

    if (segmentUrls.length === 0) {
      throw new Error('HLS плейлист не содержит аудио-сегментов');
    }

    const totalSegments = segmentUrls.length;
    const segmentBuffers = [];

    for (let i = 0; i < totalSegments; i++) {
      const segBuffer = await this.downloadBuffer(segmentUrls[i]);
      segmentBuffers.push(segBuffer);
      if (onProgress) {
        onProgress(Math.round(((i + 1) / totalSegments) * 100));
      }
    }

    const rawConcat = Buffer.concat(segmentBuffers);
    return this.extractElementaryStreamFromTs(rawConcat);
  }

  extractElementaryStreamFromTs(tsBuffer) {
    if (!Buffer.isBuffer(tsBuffer) || tsBuffer.length < 188 || tsBuffer[0] !== 0x47) {
      return tsBuffer;
    }

    const chunks = [];
    let offset = 0;
    let audioPid = null;

    while (offset + 188 <= tsBuffer.length) {
      if (tsBuffer[offset] !== 0x47) {
        let syncFound = false;
        for (let i = offset + 1; i <= Math.min(offset + 188, tsBuffer.length - 188); i++) {
          if (tsBuffer[i] === 0x47 && tsBuffer[i + 188] === 0x47) {
            offset = i;
            syncFound = true;
            break;
          }
        }
        if (!syncFound) {
          offset += 188;
          continue;
        }
      }

      const byte1 = tsBuffer[offset + 1];
      const byte2 = tsBuffer[offset + 2];
      const byte3 = tsBuffer[offset + 3];

      const pusi = (byte1 & 0x40) !== 0;
      const pid = ((byte1 & 0x1f) << 8) | byte2;
      const adaptationFieldControl = (byte3 & 0x30) >> 4;

      if (pid === 0 || pid === 1 || pid === 2 || pid === 0x1fff) {
        offset += 188;
        continue;
      }

      let payloadOffset = offset + 4;

      if (adaptationFieldControl === 2) {
        offset += 188;
        continue;
      } else if (adaptationFieldControl === 3) {
        const adaptationFieldLength = tsBuffer[offset + 4];
        payloadOffset = offset + 5 + adaptationFieldLength;
      }

      if (payloadOffset >= offset + 188) {
        offset += 188;
        continue;
      }

      if (pusi) {
        if (
          payloadOffset + 9 <= offset + 188 &&
          tsBuffer[payloadOffset] === 0x00 &&
          tsBuffer[payloadOffset + 1] === 0x00 &&
          tsBuffer[payloadOffset + 2] === 0x01
        ) {
          const streamId = tsBuffer[payloadOffset + 3];
          const pesHeaderDataLength = tsBuffer[payloadOffset + 8];
          const pesPayloadOffset = payloadOffset + 9 + pesHeaderDataLength;

          if (pesPayloadOffset < offset + 188) {
            audioPid = pid;
            chunks.push(tsBuffer.subarray(pesPayloadOffset, offset + 188));
          }
        } else if (audioPid === null || pid === audioPid) {
          chunks.push(tsBuffer.subarray(payloadOffset, offset + 188));
        }
      } else {
        if (audioPid === null || pid === audioPid) {
          chunks.push(tsBuffer.subarray(payloadOffset, offset + 188));
        }
      }

      offset += 188;
    }

    if (chunks.length === 0) return tsBuffer;
    return Buffer.concat(chunks);
  }

  sanitizeFilename(name) {
    return name
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async downloadTrack(trackUrlOrIdOrObject, targetFolder, onProgress = null) {
    if (!fs.existsSync(targetFolder)) {
      fs.mkdirSync(targetFolder, { recursive: true });
    }

    let track = null;
    if (trackUrlOrIdOrObject && typeof trackUrlOrIdOrObject === 'object' && trackUrlOrIdOrObject.transcodings) {
      track = trackUrlOrIdOrObject;
    } else {
      track = await this.resolveTrack(trackUrlOrIdOrObject);
    }

    // 1. Pick best transcoding: Progressive MP3 preferred, then HLS MP3/AAC
    let chosenTranscoding = track.transcodings.find(t => 
      t.format && t.format.protocol === 'progressive' && t.format.mime_type && t.format.mime_type.includes('mpeg')
    );

    if (!chosenTranscoding) {
      chosenTranscoding = track.transcodings.find(t => t.format && t.format.protocol === 'progressive');
    }

    if (!chosenTranscoding) {
      chosenTranscoding = track.transcodings.find(t => 
        t.format && t.format.protocol === 'hls' && t.format.mime_type && t.format.mime_type.includes('mpeg')
      );
    }

    if (!chosenTranscoding && track.transcodings.length > 0) {
      chosenTranscoding = track.transcodings[0];
    }

    if (!chosenTranscoding || !chosenTranscoding.url) {
      throw new Error('Не удалось найти подходящий аудиопоток для скачивания');
    }

    // 2. Fetch direct stream authorization
    const streamUrl = await this.fetchStreamUrl(chosenTranscoding.url);

    // 3. Download audio buffer
    let audioBuffer = null;
    if (chosenTranscoding.format && chosenTranscoding.format.protocol === 'hls') {
      audioBuffer = await this.downloadHlsStream(streamUrl, onProgress);
    } else {
      audioBuffer = await this.downloadBuffer(streamUrl, onProgress);
    }

    // 4. Download Cover Art if available
    let coverBuffer = null;
    if (track.artworkUrl) {
      try {
        coverBuffer = await this.downloadBuffer(track.artworkUrl);
      } catch (err) {
        console.warn('Failed to download cover art for tagging:', err.message);
      }
    }

    // 5. Apply ID3 Tags
    let finalBuffer = audioBuffer;
    if (!NodeID3) {
      try { NodeID3 = require('node-id3'); } catch(e) {}
    }

    if (NodeID3) {
      try {
        const tags = {
          title: track.title,
          artist: track.artist,
          album: (track.album && track.album !== 'SoundCloud') ? track.album : '',
          genre: track.genre || 'Music',
          year: track.year || String(new Date().getFullYear()),
          encodedBy: 'SoundCloud',
          comment: {
            language: 'eng',
            text: `Downloaded from SoundCloud: ${track.permalinkUrl}`
          }
        };

        if (coverBuffer) {
          tags.image = {
            mime: 'image/jpeg',
            type: { id: 3, name: 'front cover' },
            description: 'SoundCloud Artwork',
            imageBuffer: coverBuffer
          };
        }

        const tagged = NodeID3.write(tags, audioBuffer);
        if (tagged && tagged.length > 0) {
          finalBuffer = tagged;
        }
      } catch (err) {
        console.warn('Failed to embed ID3 tags with node-id3:', err.message);
      }
    }

    // 6. Save to disk
    const cleanArtist = this.sanitizeFilename(track.artist || 'SoundCloud');
    const cleanTitle = this.sanitizeFilename(track.title || 'Track');
    let baseFileName = `${cleanArtist} - ${cleanTitle}`;
    let fileName = `${baseFileName}.mp3`;
    let filePath = path.join(targetFolder, fileName);

    let counter = 1;
    while (fs.existsSync(filePath)) {
      fileName = `${baseFileName} (${counter}).mp3`;
      filePath = path.join(targetFolder, fileName);
      counter++;
    }

    fs.writeFileSync(filePath, finalBuffer);

    return {
      success: true,
      filePath,
      filename: fileName,
      track
    };
  }

  async downloadPlaylist(playlistData, targetMusicFolder, onProgress = null) {
    const clientId = await this.getClientId();
    const cleanArtist = this.sanitizeFilename(playlistData.artist || 'SoundCloud');
    const cleanAlbum = this.sanitizeFilename(playlistData.title || 'Album');

    // Create subfolder for the album inside music folder
    const albumFolderName = `${cleanArtist} - ${cleanAlbum}`;
    const albumFolderPath = path.join(targetMusicFolder, albumFolderName);
    if (!fs.existsSync(albumFolderPath)) {
      fs.mkdirSync(albumFolderPath, { recursive: true });
    }

    // 1. Download album cover.jpg inside album folder
    let albumCoverBuffer = null;
    if (playlistData.artworkUrl) {
      try {
        albumCoverBuffer = await this.downloadBuffer(playlistData.artworkUrl);
        if (albumCoverBuffer && albumCoverBuffer.length > 0) {
          fs.writeFileSync(path.join(albumFolderPath, 'cover.jpg'), albumCoverBuffer);
        }
      } catch (err) {
        console.warn('Failed to download album cover:', err.message);
      }
    }

    // 2. Fetch full track objects for any stub tracks
    let trackList = playlistData.tracks || [];
    const missingTrackIds = trackList.filter(t => !t.media || !t.media.transcodings).map(t => t.id);

    if (missingTrackIds.length > 0) {
      for (let i = 0; i < missingTrackIds.length; i += 50) {
        const batchIds = missingTrackIds.slice(i, i + 50);
        try {
          const batchUrl = `https://api-v2.soundcloud.com/tracks?ids=${batchIds.join(',')}&client_id=${clientId}`;
          const res = await this.http(batchUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
            }
          });
          if (res.ok) {
            const batchTracks = await res.json();
            const trackMap = new Map(batchTracks.map(t => [t.id, t]));
            trackList = trackList.map(t => trackMap.get(t.id) || t);
          }
        } catch (err) {
          console.warn('Failed to fetch batch tracks for playlist:', err.message);
        }
      }
    }

    const totalTracks = trackList.length;
    let downloadedCount = 0;
    const downloadedFiles = [];

    for (let index = 0; index < totalTracks; index++) {
      const rawTrack = trackList[index];
      const trackIndex = index + 1;
      const padIndex = String(trackIndex).padStart(2, '0');

      try {
        let fullTrack = rawTrack;
        if (!fullTrack.media || !fullTrack.media.transcodings) {
          try {
            fullTrack = await this.resolve(String(rawTrack.id));
          } catch(e) {
            continue;
          }
        }

        const trackTitle = (fullTrack.title || `Track ${trackIndex}`).trim();
        const trackArtist = (fullTrack.user?.username || playlistData.artist || 'SoundCloud').trim();

        if (onProgress) {
          onProgress({
            isAlbum: true,
            albumTitle: playlistData.title,
            current: trackIndex,
            total: totalTracks,
            trackTitle: trackTitle,
            percent: Math.round((index / totalTracks) * 100)
          });
        }

        const transcodings = fullTrack.media?.transcodings || fullTrack.transcodings || [];
        let chosenTranscoding = transcodings.find(t => 
          t.format && t.format.protocol === 'progressive' && t.format.mime_type && t.format.mime_type.includes('mpeg')
        );
        if (!chosenTranscoding) {
          chosenTranscoding = transcodings.find(t => t.format && t.format.protocol === 'progressive');
        }
        if (!chosenTranscoding) {
          chosenTranscoding = transcodings.find(t => 
            t.format && t.format.protocol === 'hls' && t.format.mime_type && t.format.mime_type.includes('mpeg')
          );
        }
        if (!chosenTranscoding && transcodings.length > 0) {
          chosenTranscoding = transcodings[0];
        }

        if (!chosenTranscoding || !chosenTranscoding.url) {
          continue;
        }

        const streamUrl = await this.fetchStreamUrl(chosenTranscoding.url);

        let audioBuffer = null;
        if (chosenTranscoding.format && chosenTranscoding.format.protocol === 'hls') {
          audioBuffer = await this.downloadHlsStream(streamUrl);
        } else {
          audioBuffer = await this.downloadBuffer(streamUrl);
        }

        let coverBuf = albumCoverBuffer;
        if (fullTrack.artwork_url) {
          try {
            const trackArtUrl = fullTrack.artwork_url.replace('-large.', '-t500x500.');
            coverBuf = await this.downloadBuffer(trackArtUrl);
          } catch(e) {}
        }

        let finalBuffer = audioBuffer;
        if (!NodeID3) {
          try { NodeID3 = require('node-id3'); } catch(e) {}
        }

        if (NodeID3) {
          try {
            const tags = {
              title: trackTitle,
              artist: trackArtist,
              album: playlistData.title,
              genre: fullTrack.genre || playlistData.genre || 'SoundCloud',
              year: playlistData.year,
              trackNumber: `${trackIndex}/${totalTracks}`,
              comment: {
                language: 'eng',
                text: `Downloaded from SoundCloud: ${playlistData.permalinkUrl}`
              }
            };
            if (coverBuf) {
              tags.image = {
                mime: 'image/jpeg',
                type: { id: 3, name: 'front cover' },
                description: 'Album Artwork',
                imageBuffer: coverBuf
              };
            }
            const tagged = NodeID3.write(tags, audioBuffer);
            if (tagged && tagged.length > 0) finalBuffer = tagged;
          } catch(e) {}
        }

        const cleanTitle = this.sanitizeFilename(trackTitle);
        const fileName = `${padIndex}. ${cleanTitle}.mp3`;
        const filePath = path.join(albumFolderPath, fileName);

        fs.writeFileSync(filePath, finalBuffer);
        downloadedFiles.push(filePath);
        downloadedCount++;
      } catch (trackErr) {
        console.warn(`Error downloading track ${index + 1} of album:`, trackErr.message);
      }
    }

    if (onProgress) {
      onProgress({
        isAlbum: true,
        albumTitle: playlistData.title,
        current: totalTracks,
        total: totalTracks,
        trackTitle: 'Готово',
        percent: 100
      });
    }

    return {
      success: true,
      isAlbum: true,
      albumTitle: playlistData.title,
      artist: playlistData.artist,
      tracksCount: downloadedCount,
      totalTracks: totalTracks,
      folderPath: albumFolderPath
    };
  }

  async download(urlOrIdOrObject, targetFolder, onProgress = null) {
    if (!fs.existsSync(targetFolder)) {
      fs.mkdirSync(targetFolder, { recursive: true });
    }

    let resource = urlOrIdOrObject;
    if (typeof urlOrIdOrObject === 'string') {
      resource = await this.resolve(urlOrIdOrObject);
    } else if (urlOrIdOrObject && !urlOrIdOrObject.transcodings && !urlOrIdOrObject.tracks) {
      const urlOrId = urlOrIdOrObject.permalink || urlOrIdOrObject.url || urlOrIdOrObject.id;
      if (urlOrId) {
        resource = await this.resolve(urlOrId);
      }
    }

    if (resource && (resource.kind === 'playlist' || Array.isArray(resource.tracks))) {
      return await this.downloadPlaylist(resource, targetFolder, onProgress);
    } else {
      return await this.downloadTrack(resource, targetFolder, onProgress);
    }
  }
}

module.exports = new SoundCloudDownloader();
