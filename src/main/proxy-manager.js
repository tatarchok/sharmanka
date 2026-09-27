const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');

function getCountryFlag(countryCode) {
  if (!countryCode || countryCode.length !== 2) return '🌐';
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map(char => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

class ProxyManager {
  constructor() {
    this.bridges = new Map(); // serviceName -> { server, port, config }
  }

  /**
   * Parse various proxy representations (object, string, host:port:user:pass, etc.)
   */
  parseProxyConfig(input, customUser = '', customPass = '') {
    if (!input) return null;

    let host = '';
    let port = '';
    let type = '';
    let username = (customUser || '').trim();
    let password = (customPass || '').trim();

    if (typeof input === 'object') {
      host = (input.host || input.ip || '').trim();
      port = (input.port !== undefined && input.port !== null ? String(input.port) : '').trim();
      type = (input.type || '').toLowerCase().trim();
      if (!username && input.username) username = String(input.username).trim();
      if (!password && input.password) password = String(input.password).trim();

      if (!host && input.url) {
        host = input.url.trim();
      }
    } else if (typeof input === 'string') {
      host = input.trim();
    }

    if (!host) return null;

    // Remove trailing slashes
    host = host.replace(/\/+$/, '');

    // 1. Check scheme
    const schemeMatch = host.match(/^([a-zA-Z0-9]+):\/\//);
    if (schemeMatch) {
      const proto = schemeMatch[1].toLowerCase();
      if (proto.startsWith('socks5') || proto === 'socks') type = 'socks5';
      else if (proto.startsWith('socks4')) type = 'socks4';
      else if (proto === 'http' || proto === 'https') type = 'http';
      host = host.replace(/^[a-zA-Z0-9]+:\/\//, '');
    }

    // 2. Check user:pass@host:port
    if (host.includes('@')) {
      const atParts = host.split('@');
      const authPart = atParts[0];
      host = atParts.slice(1).join('@');
      const authSplit = authPart.split(':');
      if (!username) username = decodeURIComponent(authSplit[0] || '');
      if (!password && authSplit.length > 1) password = decodeURIComponent(authSplit.slice(1).join(':') || '');
    }

    // 3. Check 4-part colon formats: host:port:user:pass OR user:pass:host:port
    const colonParts = host.split(':');
    if (colonParts.length === 4) {
      const p1 = parseInt(colonParts[1], 10);
      const p3 = parseInt(colonParts[3], 10);

      if (!isNaN(p1) && p1 > 0 && p1 <= 65535) {
        // host:port:user:pass
        host = colonParts[0].trim();
        port = String(p1);
        if (!username) username = colonParts[2].trim();
        if (!password) password = colonParts[3].trim();
      } else if (!isNaN(p3) && p3 > 0 && p3 <= 65535) {
        // user:pass:host:port
        if (!username) username = colonParts[0].trim();
        if (!password) password = colonParts[1].trim();
        host = colonParts[2].trim();
        port = String(p3);
      }
    } else if (colonParts.length === 2 && !port) {
      host = colonParts[0].trim();
      port = colonParts[1].trim();
    }

    // Clean host if extra port remained
    if (host.includes(':')) {
      const splitAgain = host.split(':');
      host = splitAgain[0].trim();
      if (!port) port = splitAgain[1].trim();
    }

    host = host.replace(/^\[|\]$/g, '').trim();

    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum <= 0 || portNum > 65535) {
      if (!port) {
        port = (type && type.startsWith('socks')) ? '1080' : '8080';
      }
    } else {
      port = String(portNum);
    }

    if (!type) {
      if (['1080', '1085', '10808', '10809', '9050', '2080', '1081'].includes(port)) {
        type = 'socks5';
      } else {
        type = 'socks5'; // Default to SOCKS5
      }
    }

    // Normalize https to http for CONNECT proxying
    if (type === 'https') {
      type = 'http';
    }

    return {
      type,
      host,
      port: parseInt(port, 10),
      username,
      password
    };
  }

  /**
   * Fast protocol auto-detection via one-roundtrip probe (SOCKS5 greeting & HTTP test)
   */
  fastDetectProtocol(host, port, timeoutMs = 2500) {
    return new Promise((resolve) => {
      const s = new net.Socket();
      s.setNoDelay(true);
      s.setTimeout(timeoutMs);
      let resolved = false;

      const finish = (result) => {
        if (resolved) return;
        resolved = true;
        s.destroy();
        resolve(result);
      };

      s.once('timeout', () => finish(null));
      s.once('error', () => finish(null));
      s.once('end', () => finish(null));
      s.once('close', () => finish(null));

      s.connect(port, host, () => {
        // Send SOCKS5 client greeting
        s.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
      });

      s.once('data', (data) => {
        if (data.length >= 2 && data[0] === 0x05) {
          return finish('socks5');
        }
        const str = data.toString('latin1');
        if (str.startsWith('HTTP/') || str.includes('HTTP/')) {
          return finish('http');
        }
        finish(null);
      });
    });
  }

  /**
   * Connect to targetHost:targetPort via SOCKS5 proxy (RFC 1928 / RFC 1929)
   */
  connectSocks5(proxyHost, proxyPort, targetHost, targetPort, username = '', password = '', timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      socket.setNoDelay(true);
      let isResolved = false;

      const done = (err, sock) => {
        if (isResolved) return;
        isResolved = true;
        socket.setTimeout(0);
        socket.removeAllListeners('timeout');
        socket.removeAllListeners('error');
        socket.removeAllListeners('end');
        socket.removeAllListeners('close');
        socket.removeAllListeners('data');
        if (err) {
          socket.destroy();
          reject(err);
        } else {
          resolve(sock);
        }
      };

      socket.setTimeout(timeoutMs);
      socket.once('timeout', () => done(new Error('Таймаут подключения к SOCKS5 прокси')));
      socket.once('error', (err) => done(err));
      socket.once('end', () => done(new Error('SOCKS5 сервер закрыл соединение (EOF)')));
      socket.once('close', () => {
        if (!isResolved) done(new Error('Соединение с SOCKS5 прокси закрыто'));
      });

      socket.connect(proxyPort, proxyHost, () => {
        // Step 1: Client Greeting
        const methods = username ? [0x00, 0x02] : [0x00, 0x02];
        const greeting = Buffer.from([0x05, methods.length, ...methods]);
        socket.write(greeting);

        let state = 'greeting';
        let buffer = Buffer.alloc(0);

        socket.on('data', function onData(chunk) {
          try {
            buffer = Buffer.concat([buffer, chunk]);

            if (state === 'greeting') {
              if (buffer.length < 2) return;
              if (buffer[0] !== 0x05) {
                return done(new Error('Некорректный ответ SOCKS5 (возможно, прокси имеет тип HTTP)'));
              }
              const chosenMethod = buffer[1];
              buffer = buffer.slice(2);

              if (chosenMethod === 0xff) {
                return done(new Error('SOCKS5 прокси требует авторизацию (укажите логин и пароль)'));
              }
              if (chosenMethod === 0x02) {
                // Username/password auth (RFC 1929)
                if (!username) {
                  return done(new Error('SOCKS5 прокси запросил авторизацию, но логин не указан'));
                }
                const uBuf = Buffer.from(username, 'utf8');
                const pBuf = Buffer.from(password || '', 'utf8');
                const authReq = Buffer.concat([
                  Buffer.from([0x01, uBuf.length]),
                  uBuf,
                  Buffer.from([pBuf.length]),
                  pBuf
                ]);
                state = 'auth';
                socket.write(authReq);
                return;
              }
              if (chosenMethod === 0x00) {
                // No auth required
                state = 'connect';
                sendConnect();
                return;
              }
              return done(new Error(`Неподдерживаемый метод аутентификации SOCKS5 (0x${chosenMethod.toString(16)})`));
            }

            if (state === 'auth') {
              if (buffer.length < 2) return;
              const status = buffer[1];
              buffer = buffer.slice(2);

              if (status !== 0x00) {
                return done(new Error('Ошибка авторизации SOCKS5: неверный логин или пароль'));
              }
              state = 'connect';
              sendConnect();
              return;
            }

            if (state === 'connect') {
              if (buffer.length < 4) return;
              if (buffer[0] !== 0x05) {
                return done(new Error('Некорректный ответ SOCKS5 сервера при установке туннеля'));
              }
              const rep = buffer[1];
              if (rep !== 0x00) {
                const repErrors = {
                  1: 'Общая ошибка SOCKS5 сервера',
                  2: 'Подключение запрещено правилами SOCKS5',
                  3: 'Сеть недоступна',
                  4: 'Хост недоступен',
                  5: 'Отказ в подключении целевым сервером',
                  6: 'TTL истек',
                  7: 'Команда не поддерживается',
                  8: 'Тип адреса не поддерживается'
                };
                return done(new Error(repErrors[rep] || `Ошибка подключения через SOCKS5 (код ${rep})`));
              }

              const atyp = buffer[3];
              let headerLen = 4;
              if (atyp === 0x01) headerLen += 4 + 2; // IPv4 + port
              else if (atyp === 0x03) {
                if (buffer.length < 5) return;
                const dLen = buffer[4];
                headerLen += 1 + dLen + 2; // domain len + domain + port
              } else if (atyp === 0x04) headerLen += 16 + 2; // IPv6 + port

              if (buffer.length < headerLen) return;

              // SOCKS5 tunnel is established!
              const unconsumed = buffer.slice(headerLen);
              if (unconsumed.length > 0) {
                socket.unshift(unconsumed);
              }
              done(null, socket);
            }
          } catch (e) {
            done(e);
          }
        });

        function sendConnect() {
          const isIp = net.isIP(targetHost);
          let addrBuf;
          if (isIp === 4) {
            const parts = targetHost.split('.').map(Number);
            addrBuf = Buffer.from([0x01, ...parts]);
          } else {
            const hBuf = Buffer.from(targetHost, 'utf8');
            addrBuf = Buffer.concat([Buffer.from([0x03, hBuf.length]), hBuf]);
          }

          const portBuf = Buffer.alloc(2);
          portBuf.writeUInt16BE(targetPort, 0);

          const req = Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00]),
            addrBuf,
            portBuf
          ]);
          socket.write(req);
        }
      });
    });
  }

  /**
   * Connect to targetHost:targetPort via HTTP CONNECT proxy
   */
  connectHttp(proxyHost, proxyPort, targetHost, targetPort, username = '', password = '', timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      socket.setNoDelay(true);
      let isResolved = false;

      const done = (err, sock) => {
        if (isResolved) return;
        isResolved = true;
        socket.setTimeout(0);
        socket.removeAllListeners('timeout');
        socket.removeAllListeners('error');
        socket.removeAllListeners('end');
        socket.removeAllListeners('close');
        socket.removeAllListeners('data');
        if (err) {
          socket.destroy();
          reject(err);
        } else {
          resolve(sock);
        }
      };

      socket.setTimeout(timeoutMs);
      socket.once('timeout', () => done(new Error('Таймаут подключения к HTTP прокси')));
      socket.once('error', (err) => done(err));
      socket.once('end', () => done(new Error('HTTP прокси закрыл соединение (EOF)')));
      socket.once('close', () => {
        if (!isResolved) done(new Error('Соединение с HTTP прокси закрыто'));
      });

      socket.connect(proxyPort, proxyHost, () => {
        let headers = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nUser-Agent: Mozilla/5.0\r\nProxy-Connection: Keep-Alive\r\n`;
        if (username) {
          const authBase64 = Buffer.from(`${username}:${password || ''}`).toString('base64');
          headers += `Proxy-Authorization: Basic ${authBase64}\r\n`;
        }
        headers += '\r\n';

        socket.write(headers);

        let buffer = Buffer.alloc(0);
        socket.on('data', function onData(chunk) {
          buffer = Buffer.concat([buffer, chunk]);
          const headerEnd = buffer.indexOf('\r\n\r\n');
          if (headerEnd !== -1) {
            const headStr = buffer.slice(0, headerEnd).toString('latin1');
            const statusLine = headStr.split('\r\n')[0] || '';
            const match = statusLine.match(/HTTP\/\d\.\d\s+(\d+)/i);
            const statusCode = match ? parseInt(match[1], 10) : 0;

            if (statusCode === 200 || (statusCode >= 200 && statusCode < 300)) {
              const remaining = buffer.slice(headerEnd + 4);
              if (remaining.length > 0) {
                socket.unshift(remaining);
              }
              done(null, socket);
            } else if (statusCode === 407) {
              done(new Error('Ошибка авторизации HTTP прокси (407 Proxy Authentication Required): неверный логин или пароль'));
            } else if (statusCode === 403) {
              done(new Error('Доступ запрещен HTTP прокси (403 Forbidden)'));
            } else {
              done(new Error(`HTTP прокси отклонил туннель: ${statusLine || 'Неизвестная ошибка'}`));
            }
          }
        });
      });
    });
  }

  /**
   * Connect to targetHost:targetPort via SOCKS4 / SOCKS4a proxy
   */
  connectSocks4(proxyHost, proxyPort, targetHost, targetPort, userId = '', timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      socket.setNoDelay(true);
      let isResolved = false;

      const done = (err, sock) => {
        if (isResolved) return;
        isResolved = true;
        socket.setTimeout(0);
        socket.removeAllListeners('timeout');
        socket.removeAllListeners('error');
        socket.removeAllListeners('end');
        socket.removeAllListeners('close');
        socket.removeAllListeners('data');
        if (err) {
          socket.destroy();
          reject(err);
        } else {
          resolve(sock);
        }
      };

      socket.setTimeout(timeoutMs);
      socket.once('timeout', () => done(new Error('Таймаут подключения к SOCKS4 прокси')));
      socket.once('error', (err) => done(err));
      socket.once('end', () => done(new Error('SOCKS4 прокси закрыл соединение (EOF)')));
      socket.once('close', () => {
        if (!isResolved) done(new Error('Соединение с SOCKS4 прокси закрыто'));
      });

      socket.connect(proxyPort, proxyHost, () => {
        const isIp = net.isIP(targetHost) === 4;
        const portBuf = Buffer.alloc(2);
        portBuf.writeUInt16BE(targetPort, 0);

        let req;
        const uBuf = Buffer.from(userId || 'user', 'utf8');

        if (isIp) {
          const ipParts = targetHost.split('.').map(Number);
          req = Buffer.concat([
            Buffer.from([0x04, 0x01]),
            portBuf,
            Buffer.from(ipParts),
            uBuf,
            Buffer.from([0x00])
          ]);
        } else {
          const hBuf = Buffer.from(targetHost, 'utf8');
          req = Buffer.concat([
            Buffer.from([0x04, 0x01]),
            portBuf,
            Buffer.from([0x00, 0x00, 0x00, 0x01]),
            uBuf,
            Buffer.from([0x00]),
            hBuf,
            Buffer.from([0x00])
          ]);
        }

        socket.write(req);

        let buffer = Buffer.alloc(0);
        socket.on('data', function onData(chunk) {
          buffer = Buffer.concat([buffer, chunk]);
          if (buffer.length >= 8) {
            const status = buffer[1];
            if (status === 0x5a) {
              const remaining = buffer.slice(8);
              if (remaining.length > 0) socket.unshift(remaining);
              done(null, socket);
            } else {
              done(new Error(`SOCKS4 прокси отклонил запрос (код 0x${status.toString(16)})`));
            }
          }
        });
      });
    });
  }

  /**
   * Create an upstream socket tunnel with auto-fallback and protocol caching
   */
  async createTunnel(proxyConfig, targetHost, targetPort, timeoutMs = 8000) {
    const requestedType = (proxyConfig.type || 'socks5').toLowerCase();
    
    // Order to try: requested type first, then alternate protocols
    const typesToTry = [requestedType];
    if (requestedType === 'socks5') {
      typesToTry.push('http', 'socks4');
    } else if (requestedType === 'http') {
      typesToTry.push('socks5', 'socks4');
    } else {
      typesToTry.push('socks5', 'http');
    }

    let lastError = null;
    for (const t of typesToTry) {
      try {
        let sock;
        if (t === 'socks5') {
          sock = await this.connectSocks5(proxyConfig.host, proxyConfig.port, targetHost, targetPort, proxyConfig.username, proxyConfig.password, timeoutMs);
        } else if (t === 'http') {
          sock = await this.connectHttp(proxyConfig.host, proxyConfig.port, targetHost, targetPort, proxyConfig.username, proxyConfig.password, timeoutMs);
        } else if (t === 'socks4') {
          sock = await this.connectSocks4(proxyConfig.host, proxyConfig.port, targetHost, targetPort, proxyConfig.username, timeoutMs);
        }
        if (sock) {
          proxyConfig.type = t; // Cache working protocol
          return sock;
        }
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new Error('Не удалось установить туннель через прокси');
  }

  /**
   * Fetch Geo metadata for detected external IP
   */
  async fetchGeo(ip) {
    if (!ip || ip === '127.0.0.1') return null;
    
    const endpoints = [
      `https://ipapi.co/${ip}/json/`,
      `http://ip-api.com/json/${ip}?fields=status,message,country,countryCode,city,query`,
      `https://ipwho.is/${ip}`
    ];

    for (const ep of endpoints) {
      try {
        const data = await new Promise((resolve, reject) => {
          const mod = ep.startsWith('https') ? https : http;
          const req = mod.get(ep, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 3000 }, (res) => {
            let raw = '';
            res.on('data', d => raw += d);
            res.on('end', () => {
              try {
                resolve(JSON.parse(raw));
              } catch (e) {
                reject(e);
              }
            });
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        });

        if (data) {
          const country = data.country_name || data.country || '';
          const code = data.country_code || data.countryCode || '';
          const city = data.city || '';
          if (country || code) {
            return {
              country,
              countryCode: code,
              city,
              flag: getCountryFlag(code)
            };
          }
        }
      } catch (e) {}
    }
    return null;
  }

  /**
   * Diagnostic tester: checks TCP Ping, Protocol Tunnel Handshake, and External IP Fetch
   */
  async testProxy(rawConfig) {
    const parsed = this.parseProxyConfig(rawConfig, rawConfig?.username, rawConfig?.password);
    if (!parsed || !parsed.host || !parsed.port) {
      return { success: false, error: 'Укажите хост (IP) и порт прокси' };
    }

    // Step 1: TCP Ping check
    const startTime = Date.now();
    let tcpPingMs = 0;
    try {
      await new Promise((resolve, reject) => {
        const s = new net.Socket();
        s.setTimeout(3500);
        s.once('connect', () => {
          tcpPingMs = Date.now() - startTime;
          s.destroy();
          resolve();
        });
        s.once('timeout', () => {
          s.destroy();
          reject(new Error(`Хост ${parsed.host}:${parsed.port} не отвечает (таймаут 3.5 сек)`));
        });
        s.once('error', (err) => {
          s.destroy();
          if (err.code === 'ECONNREFUSED') {
            reject(new Error(`Подключение отклонено (порт ${parsed.port} на ${parsed.host} закрыт)`));
          } else if (err.code === 'ENOTFOUND') {
            reject(new Error(`Хост ${parsed.host} не найден (ошибка DNS)`));
          } else {
            reject(new Error(`Не удалось подключиться к ${parsed.host}:${parsed.port}: ${err.message}`));
          }
        });
        s.connect(parsed.port, parsed.host);
      });
    } catch (e) {
      return { success: false, error: e.message };
    }

    // Step 2: Protocol Handshake & External IP retrieval
    const fastDetected = await this.fastDetectProtocol(parsed.host, parsed.port, 2000);
    const protocolsToTry = [];
    if (fastDetected) protocolsToTry.push(fastDetected);
    if (!protocolsToTry.includes(parsed.type)) protocolsToTry.push(parsed.type);
    ['socks5', 'http', 'socks4'].forEach(p => { if (!protocolsToTry.includes(p)) protocolsToTry.push(p); });

    const testTargets = [
      { host: 'api.ipify.org', port: 443, path: '/?format=json', isJson: true },
      { host: 'icanhazip.com', port: 443, path: '/', isJson: false },
      { host: 'cloudflare.com', port: 443, path: '/cdn-cgi/trace', isTrace: true }
    ];

    let workingProtocol = null;
    let detectedIp = null;
    let lastError = null;
    // A clear answer from the proxy ("wrong login/password") must not be replaced by the
    // errors of the other protocols we try afterwards
    let authError = null;

    for (const proto of protocolsToTry) {
      if (authError) break;
      const probeCfg = { ...parsed, type: proto };
      for (const target of testTargets) {
        try {
          let tunnelSocket;
          if (proto === 'socks5') {
            tunnelSocket = await this.connectSocks5(probeCfg.host, probeCfg.port, target.host, target.port, probeCfg.username, probeCfg.password, 4500);
          } else if (proto === 'http') {
            tunnelSocket = await this.connectHttp(probeCfg.host, probeCfg.port, target.host, target.port, probeCfg.username, probeCfg.password, 4500);
          } else if (proto === 'socks4') {
            tunnelSocket = await this.connectSocks4(probeCfg.host, probeCfg.port, target.host, target.port, probeCfg.username, 4500);
          }

          const tlsSocket = tls.connect({
            socket: tunnelSocket,
            servername: target.host,
            rejectUnauthorized: false
          });

          const ip = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              tlsSocket.destroy();
              reject(new Error('Таймаут ответа целевого сервера'));
            }, 5000);

            tlsSocket.once('error', (err) => {
              clearTimeout(timeout);
              tlsSocket.destroy();
              reject(err);
            });

            tlsSocket.once('secureConnect', () => {
              const req = `GET ${target.path} HTTP/1.1\r\nHost: ${target.host}\r\nUser-Agent: Mozilla/5.0\r\nConnection: close\r\n\r\n`;
              tlsSocket.write(req);
            });

            let rawData = '';
            tlsSocket.on('data', (chunk) => {
              rawData += chunk.toString('utf8');
            });

            tlsSocket.on('end', () => {
              clearTimeout(timeout);
              try {
                const bodyIndex = rawData.indexOf('\r\n\r\n');
                const body = bodyIndex !== -1 ? rawData.slice(bodyIndex + 4).trim() : rawData.trim();
                if (target.isJson) {
                  const parsedJson = JSON.parse(body);
                  resolve(parsedJson.ip || body);
                } else if (target.isTrace) {
                  const m = body.match(/ip=([^\s]+)/);
                  resolve(m ? m[1] : 'OK');
                } else {
                  resolve(body.split('\n')[0].trim() || 'OK');
                }
              } catch (e) {
                resolve('OK');
              }
            });
          });

          if (ip) {
            workingProtocol = proto;
            detectedIp = ip;
            break;
          }
        } catch (err) {
          lastError = err;
          if (/логин|авторизац|407/i.test(err.message || '')) {
            authError = err;
            break;
          }
        }
      }

      if (workingProtocol && detectedIp) break;
    }

    if (!workingProtocol || !detectedIp) {
      return {
        success: false,
        error: (authError || lastError)?.message || 'Не удалось выполнить запрос через прокси (проверьте логин, пароль и тип)',
        pingMs: tcpPingMs
      };
    }

    const totalLatency = Date.now() - startTime;
    const geo = await this.fetchGeo(detectedIp);

    let warning = '';
    if (geo && geo.countryCode === 'RU') {
      warning = '⚠️ Этот прокси находится в РФ (Россия). Сервис SoundCloud заблокирован на территории РФ! Для SoundCloud используйте зарубежный прокси (США, Германия, Нидерланды и др.). Прокси в РФ подходит только для Яндекс.Музыки.';
    }

    return {
      success: true,
      ip: detectedIp,
      latencyMs: totalLatency,
      pingMs: tcpPingMs,
      type: parsed.type,
      detectedType: workingProtocol,
      typeMismatch: workingProtocol !== parsed.type,
      host: parsed.host,
      port: parsed.port,
      country: geo?.country || '',
      countryCode: geo?.countryCode || '',
      city: geo?.city || '',
      flag: geo?.flag || '🌐',
      warning
    };
  }

  /**
   * Start local HTTP bridge server for a specific service session
   */
  async startBridgeForService(serviceName, proxyConfig) {
    await this.stopBridgeForService(serviceName);

    const parsed = this.parseProxyConfig(proxyConfig, proxyConfig?.username, proxyConfig?.password);
    if (!parsed || !parsed.host || !parsed.port) {
      return null;
    }

    // Fast probe to detect and cache actual working protocol
    const detected = await this.fastDetectProtocol(parsed.host, parsed.port, 2000);
    if (detected) {
      parsed.type = detected;
    }

    const server = http.createServer((req, res) => {
      let parsedUrl;
      try {
        parsedUrl = new URL(req.url.startsWith('http') ? req.url : `http://${req.headers.host || '127.0.0.1'}${req.url}`);
      } catch (e) {
        if (!res.headersSent) res.writeHead(400);
        return res.end();
      }

      const targetPort = parsedUrl.port ? parseInt(parsedUrl.port, 10) : 80;
      const targetHost = parsedUrl.hostname;

      this.createTunnel(parsed, targetHost, targetPort, 10000)
        .then((tunnel) => {
          let headersStr = `${req.method} ${parsedUrl.pathname || '/'}${parsedUrl.search || ''} HTTP/${req.httpVersion}\r\n`;
          for (let i = 0; i < req.rawHeaders.length; i += 2) {
            const key = req.rawHeaders[i];
            const val = req.rawHeaders[i + 1];
            if (key.toLowerCase() === 'proxy-connection') continue;
            headersStr += `${key}: ${val}\r\n`;
          }
          headersStr += '\r\n';

          tunnel.write(headersStr);
          req.pipe(tunnel);
          tunnel.pipe(req.socket);

          tunnel.on('error', () => req.socket.destroy());
          req.socket.on('error', () => tunnel.destroy());
          tunnel.on('close', () => req.socket.destroy());
          req.socket.on('close', () => tunnel.destroy());
        })
        .catch((err) => {
          if (!res.headersSent) {
            try {
              res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
              res.end(`Proxy Bridge Error: ${err.message}`);
            } catch (e) {}
          }
        });
    });

    server.on('connect', (req, clientSocket, head) => {
      clientSocket.setNoDelay(true);

      let targetHost = '';
      let targetPort = 443;
      try {
        const lastColon = req.url.lastIndexOf(':');
        if (lastColon !== -1) {
          targetHost = req.url.slice(0, lastColon).replace(/^\[|\]$/g, '');
          targetPort = parseInt(req.url.slice(lastColon + 1), 10) || 443;
        } else {
          targetHost = req.url.replace(/^\[|\]$/g, '');
          targetPort = 443;
        }
      } catch (e) {
        clientSocket.destroy();
        return;
      }

      let clientClosed = false;
      const onClientClose = () => { clientClosed = true; };
      clientSocket.once('error', onClientClose);
      clientSocket.once('close', onClientClose);

      this.createTunnel(parsed, targetHost, targetPort, 10000)
        .then((upstreamSocket) => {
          clientSocket.removeListener('error', onClientClose);
          clientSocket.removeListener('close', onClientClose);

          if (clientClosed || clientSocket.destroyed) {
            upstreamSocket.destroy();
            return;
          }

          upstreamSocket.setNoDelay(true);
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head && head.length > 0) {
            upstreamSocket.write(head);
          }
          upstreamSocket.pipe(clientSocket);
          clientSocket.pipe(upstreamSocket);

          upstreamSocket.on('error', () => clientSocket.destroy());
          clientSocket.on('error', () => upstreamSocket.destroy());
          upstreamSocket.on('close', () => clientSocket.destroy());
          clientSocket.on('close', () => upstreamSocket.destroy());
        })
        .catch((err) => {
          if (!clientClosed && !clientSocket.destroyed) {
            try {
              clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nProxy Tunnel Error: ${err.message}`);
            } catch (e) {}
            clientSocket.destroy();
          }
        });
    });

    // Track sockets: webviews keep connections alive, and server.close() alone would wait for them forever
    const sockets = new Set();
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });

    return new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const localPort = address.port;
        this.bridges.set(serviceName, { server, sockets, port: localPort, config: parsed });
        console.log(`[ProxyBridge] Started local bridge for [${serviceName}] on 127.0.0.1:${localPort} -> ${parsed.type}://${parsed.host}:${parsed.port}`);
        resolve({ port: localPort, rules: `http://127.0.0.1:${localPort}` });
      });

      server.on('error', (err) => {
        console.error(`[ProxyBridge] Server error for [${serviceName}]:`, err);
        reject(err);
      });
    });
  }

  async stopBridgeForService(serviceName) {
    const existing = this.bridges.get(serviceName);
    if (!existing || !existing.server) return;
    this.bridges.delete(serviceName);
    return new Promise((resolve) => {
      existing.server.close(() => resolve());
      // Drop open (keep-alive / tunnelled) connections so close() completes right away
      if (existing.sockets) existing.sockets.forEach(s => s.destroy());
      setTimeout(resolve, 1000);
      console.log(`[ProxyBridge] Stopped bridge for [${serviceName}]`);
    });
  }

  async stopAll() {
    for (const serviceName of Array.from(this.bridges.keys())) {
      await this.stopBridgeForService(serviceName);
    }
  }

  /**
   * Configure proxy settings for an Electron session instance
   */
  async applySessionProxy(sessionInstance, proxyConfig, serviceName = '') {
    if (!sessionInstance) return;
    try {
      if (proxyConfig && proxyConfig.enabled) {
        const bridge = await this.startBridgeForService(serviceName || 'default', proxyConfig);
        if (bridge) {
          console.log(`[Proxy] Applying proxy bridge for session [${serviceName}]: ${bridge.rules}`);
          await sessionInstance.setProxy({
            proxyRules: bridge.rules,
            proxyBypassRules: '<local>;localhost;127.0.0.1'
          });

          try {
            if (typeof sessionInstance.clearAuthCache === 'function') await sessionInstance.clearAuthCache();
            if (typeof sessionInstance.closeAllConnections === 'function') await sessionInstance.closeAllConnections();
            if (typeof sessionInstance.clearHostResolverCache === 'function') await sessionInstance.clearHostResolverCache();
          } catch (e) {}
          return;
        }
      }

      // Direct mode
      await this.stopBridgeForService(serviceName || 'default');
      console.log(`[Proxy] Disabling proxy for session [${serviceName || 'default'}] (direct)`);
      await sessionInstance.setProxy({ mode: 'direct' });
      try {
        if (typeof sessionInstance.clearAuthCache === 'function') await sessionInstance.clearAuthCache();
        if (typeof sessionInstance.closeAllConnections === 'function') await sessionInstance.closeAllConnections();
        if (typeof sessionInstance.clearHostResolverCache === 'function') await sessionInstance.clearHostResolverCache();
      } catch (e) {}
    } catch (err) {
      console.warn(`[Proxy] Failed to apply proxy for [${serviceName}]:`, err.message);
    }
  }
}

module.exports = new ProxyManager();
