/* ==========================================================================
   Beat-reactive animated background.
   Levels come from the active source: the local player's EQ chain (AnalyserNode)
   or, for SoundCloud / Yandex Music, 16 bands sent by their page bridges.
   Drawn on a canvas behind the whole UI (under the dim overlay).
   ========================================================================== */

const BG_ANIMATION_PRESETS = {
  none: 'Нет',
  pulse: 'Пульс',
  waves: 'Волны',
  particles: 'Частицы',
  spectrum: 'Спектр',
  aurora: 'Аура'
};

class BackgroundVisualizer {
  constructor() {
    this.preset = 'none';
    this.sensitivity = 1;
    this.BANDS = 16;
    this.bands = new Float32Array(this.BANDS);   // smoothed 0..1
    this.bass = 0;
    this.mid = 0;
    this.high = 0;
    this.energy = 0;
    this.beat = 0;
    this.bassAvg = 0;
    this.lastBeatAt = 0;
    this.serviceLevels = null;                   // { service, bands, at }
    this.localAnalyser = null;
    this.localAnalyserCtx = null;
    this.rings = [];
    this.particles = [];
    this.running = false;
    this.lastFrame = 0;
    this.time = 0;
    this.color = { r: 99, g: 102, b: 241 };
    this.color2 = { r: 168, g: 85, b: 247 };

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'app-background-canvas';
    this.canvas.id = 'app-bg-canvas';
    const layer = document.getElementById('app-bg-layer');
    const overlay = document.getElementById('app-bg-overlay');
    if (layer) layer.insertBefore(this.canvas, overlay || null);
    this.ctx = this.canvas.getContext('2d');

    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.running) requestAnimationFrame((t) => this.frame(t));
    });
    this.resize();
  }

  isActive() {
    return this.preset !== 'none';
  }

  setPreset(preset) {
    const next = BG_ANIMATION_PRESETS[preset] ? preset : 'none';
    this.preset = next;
    const active = next !== 'none';
    document.body.classList.toggle('bg-anim', active);
    this.canvas.style.display = active ? 'block' : 'none';
    // Soft look for the aurora: draw at low resolution and blur
    this.canvas.style.filter = next === 'aurora' ? 'blur(40px) saturate(1.3)' : '';
    this.rings = [];
    this.particles = [];
    this.waves = null;
    this.resize();
    this.notifyBridges(active);
    if (active && !this.running) {
      this.running = true;
      requestAnimationFrame((t) => this.frame(t));
    } else if (!active) {
      this.running = false;
    }
  }

  setSensitivity(value) {
    this.sensitivity = Math.max(0.3, Math.min(2.5, Number(value) || 1));
  }

  notifyBridges(enabled) {
    const player = window.localPlayer;
    if (!player) return;
    player.sendWebviewCommand('wv-soundcloud', 'setVisualizer', enabled);
    player.sendWebviewCommand('wv-yandex', 'setVisualizer', enabled);
  }

  pushServiceLevels(service, bands) {
    if (!Array.isArray(bands)) return;
    this.serviceLevels = { service, bands, at: performance.now() };
  }

  resize() {
    // Soft full-screen shapes are drawn at a lower resolution and stretched by CSS:
    // far fewer pixels to fill and re-blur under the glass panels every frame
    const RENDER_SCALE = { aurora: 0.35, waves: 0.5 };
    const scale = RENDER_SCALE[this.preset] || 1;
    this.renderScale = scale;
    const w = Math.max(1, Math.round(window.innerWidth * scale));
    const h = Math.max(1, Math.round(window.innerHeight * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  // ---- levels ---------------------------------------------------------------
  readRawBands() {
    const player = window.localPlayer;
    const raw = new Float32Array(this.BANDS);
    if (!player) return raw;

    if (player.activeSource === 'local') {
      if (!player.isPlaying) return raw;
      const ctx = player.eqAudioCtx;
      const last = player.eqFilters && player.eqFilters[player.eqFilters.length - 1];
      if (!ctx || !last) return raw;
      if (this.localAnalyserCtx !== ctx) {
        try {
          this.localAnalyser = ctx.createAnalyser();
          this.localAnalyser.fftSize = 1024;
          this.localAnalyser.smoothingTimeConstant = 0.55;
          last.connect(this.localAnalyser);
          this.localAnalyserCtx = ctx;
        } catch (e) {
          return raw;
        }
      }
      const data = new Uint8Array(this.localAnalyser.frequencyBinCount);
      this.localAnalyser.getByteFrequencyData(data);
      const nyquist = ctx.sampleRate / 2;
      for (let b = 0; b < this.BANDS; b++) {
        const f0 = 30 * Math.pow(16000 / 30, b / this.BANDS);
        const f1 = 30 * Math.pow(16000 / 30, (b + 1) / this.BANDS);
        const i0 = Math.floor((f0 / nyquist) * data.length);
        const i1 = Math.max(i0 + 1, Math.ceil((f1 / nyquist) * data.length));
        let peak = 0;
        for (let i = i0; i < i1 && i < data.length; i++) peak = Math.max(peak, data[i]);
        raw[b] = peak / 255;
      }
      return raw;
    }

    const s = this.serviceLevels;
    if (s && s.service === player.activeSource && performance.now() - s.at < 400) {
      for (let b = 0; b < this.BANDS; b++) raw[b] = (s.bands[b] || 0) / 255;
    }
    return raw;
  }

  updateLevels(now) {
    const raw = this.readRawBands();
    for (let b = 0; b < this.BANDS; b++) {
      const target = Math.min(1, raw[b] * this.sensitivity);
      const k = target > this.bands[b] ? 0.55 : 0.12;   // fast attack, slow release
      this.bands[b] += (target - this.bands[b]) * k;
    }
    const avg = (from, to) => {
      let s = 0;
      for (let i = from; i <= to; i++) s += this.bands[i];
      return s / (to - from + 1);
    };
    this.bass = avg(0, 2);
    this.mid = avg(4, 9);
    this.high = avg(10, 15);
    this.energy = avg(0, 15);

    // Beat: bass clearly above its running average
    if (this.bass > this.bassAvg * 1.25 + 0.06 && this.bass > 0.3 && now - this.lastBeatAt > 240) {
      this.beat = 1;
      this.lastBeatAt = now;
      this.onBeat();
    }
    this.beat *= 0.9;
    this.bassAvg = this.bassAvg * 0.94 + this.bass * 0.06;
  }

  onBeat() {
    if (this.preset === 'pulse') {
      this.rings.push({ r: 0.08, a: 0.9 });
      if (this.rings.length > 8) this.rings.shift();
    }
  }

  readAccent() {
    // Registered as <color>, so the computed value is "rgb(r, g, b)" (or #hex from older styles)
    const css = getComputedStyle(document.documentElement).getPropertyValue('--accent-primary').trim();
    let c = null;
    const hex = css.match(/^#([0-9a-f]{6})$/i);
    const rgb = css.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
    if (hex) {
      const n = parseInt(hex[1], 16);
      c = { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    } else if (rgb) {
      c = { r: +rgb[1], g: +rgb[2], b: +rgb[3] };
    }
    if (!c) return;
    if (c.r === this.color.r && c.g === this.color.g && c.b === this.color.b) return;
    this.color = c;
    this.color2 = BackgroundVisualizer.shiftHue(c, 45);
  }

  static shiftHue({ r, g, b }, deg) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h /= 6;
    }
    h = (h + deg / 360) % 1;
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    if (s === 0) return { r: Math.round(l * 255), g: Math.round(l * 255), b: Math.round(l * 255) };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return { r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255), g: Math.round(hue2rgb(p, q, h) * 255), b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255) };
  }

  rgba(c, a) {
    return `rgba(${c.r}, ${c.g}, ${c.b}, ${Math.max(0, Math.min(1, a))})`;
  }

  // ---- render loop ----------------------------------------------------------
  frame(now) {
    if (!this.running || this.preset === 'none') return;
    if (document.hidden) return; // resumed by visibilitychange
    const dt = Math.min(0.05, (now - (this.lastFrame || now)) / 1000);
    this.lastFrame = now;
    this.time += dt;
    if (Math.floor(now / 1000) !== Math.floor((now - dt * 1000) / 1000)) this.readAccent();
    this.updateLevels(now);

    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#05050a';
    ctx.fillRect(0, 0, w, h);

    const draw = this[`draw_${this.preset}`];
    if (draw) draw.call(this, ctx, w, h, dt);

    requestAnimationFrame((t) => this.frame(t));
  }

  // "Пульс": glow in the center that breathes with the bass, rings on every beat
  draw_pulse(ctx, w, h) {
    const cx = w / 2;
    const cy = h * 0.52;
    const base = Math.min(w, h);
    const idle = 0.04 * Math.sin(this.time * 1.2);
    const r1 = base * (0.32 + idle + this.bass * 0.38 + this.beat * 0.08);
    let g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r1);
    g.addColorStop(0, this.rgba(this.color, 0.55 + this.bass * 0.4));
    g.addColorStop(0.45, this.rgba(this.color, 0.18 + this.bass * 0.2));
    g.addColorStop(1, this.rgba(this.color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    const r2 = base * (0.18 + this.mid * 0.3);
    g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r2);
    g.addColorStop(0, this.rgba(this.color2, 0.35 + this.mid * 0.4));
    g.addColorStop(1, this.rgba(this.color2, 0));
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    ctx.lineWidth = 3;
    this.rings = this.rings.filter(ring => ring.a > 0.02);
    for (const ring of this.rings) {
      ring.r += 0.012 + this.energy * 0.01;
      ring.a *= 0.955;
      ctx.strokeStyle = this.rgba(this.color, ring.a * 0.8);
      ctx.beginPath();
      ctx.arc(cx, cy, base * ring.r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // "Волны": layered waves whose height follows the music
  draw_waves(ctx, w, h, dt) {
    const layers = 5;
    const SEGMENTS = 72; // constant detail regardless of window size
    if (!this.waves) {
      this.waves = Array.from({ length: layers }, (_, i) => ({ phase: i * 1.3, phase2: i * 0.7, amp: 0, glow: 0 }));
    }
    for (let i = 0; i < layers; i++) {
      const layer = this.waves[i];
      const band = this.bands[Math.min(this.BANDS - 1, i * 3)];

      // Phase is accumulated per frame: music changes the SPEED of the waves, never their position.
      // (phase = time * speed made every volume change teleport the waves, worse the longer the app ran)
      const speed = 0.6 + i * 0.25 + this.energy * 1.2;
      layer.phase = (layer.phase + speed * dt) % (Math.PI * 2);
      layer.phase2 = (layer.phase2 - speed * 0.7 * dt) % (Math.PI * 2);

      // Height and brightness ease towards the music (~0.25 s) instead of following every frame
      const targetAmp = 0.03 + this.energy * 0.1 + band * 0.1 + this.beat * 0.02;
      const k = Math.min(1, dt * 4);
      layer.amp += (targetAmp - layer.amp) * k;
      layer.glow += (band - layer.glow) * k;

      const amp = h * layer.amp;
      const baseY = h * (0.5 + i * 0.07);
      const freq = (0.004 + i * 0.0012) * (1400 / Math.max(1, w / (this.renderScale || 1)));
      const color = i % 2 ? this.color2 : this.color;
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let s = 0; s <= SEGMENTS; s++) {
        const x = (s / SEGMENTS) * w;
        const px = x / (this.renderScale || 1); // frequency in screen pixels, independent of render scale
        const y = baseY
          + Math.sin(px * freq + layer.phase) * amp
          + Math.sin(px * freq * 2.3 + layer.phase2) * amp * 0.35;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, baseY - amp, 0, h);
      g.addColorStop(0, this.rgba(color, 0.28 + layer.glow * 0.22));
      g.addColorStop(1, this.rgba(color, 0.02));
      ctx.fillStyle = g;
      ctx.fill();
    }
  }

  // "Частицы": glowing dust that speeds up and flares on the bass
  draw_particles(ctx, w, h, dt) {
    const target = Math.round(Math.min(220, (w * h) / 9000));
    while (this.particles.length < target) {
      this.particles.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 20,
        vy: -10 - Math.random() * 30,
        r: 1 + Math.random() * 2.5,
        c: Math.random() < 0.5 ? 0 : 1,
        tw: Math.random() * Math.PI * 2
      });
    }
    const boost = 1 + this.bass * 5 + this.beat * 6;
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      p.x += p.vx * dt * boost;
      p.y += p.vy * dt * boost;
      if (p.y < -10) { p.y = h + 10; p.x = Math.random() * w; }
      if (p.x < -10) p.x = w + 10;
      if (p.x > w + 10) p.x = -10;
      const size = p.r * (1 + this.mid * 2.2 + this.beat * 1.5);
      const alpha = 0.35 + 0.35 * Math.sin(this.time * 2 + p.tw) + this.high * 0.4;
      const color = p.c ? this.color2 : this.color;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, size * 4);
      g.addColorStop(0, this.rgba(color, alpha));
      g.addColorStop(1, this.rgba(color, 0));
      ctx.fillStyle = g;
      ctx.fillRect(p.x - size * 4, p.y - size * 4, size * 8, size * 8);
    }
    ctx.globalCompositeOperation = 'source-over';
    // faint floor glow on the beat
    const g = ctx.createLinearGradient(0, h, 0, h * 0.6);
    g.addColorStop(0, this.rgba(this.color, 0.12 + this.beat * 0.25));
    g.addColorStop(1, this.rgba(this.color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, h * 0.6, w, h * 0.4);
  }

  // "Спектр": mirrored spectrum bars along the bottom
  draw_spectrum(ctx, w, h) {
    const bars = 48;
    const gap = Math.max(2, w / bars * 0.25);
    const barW = (w - gap * (bars + 1)) / bars;
    const maxH = h * 0.5;
    const baseY = h * 0.82;
    const glow = ctx.createRadialGradient(w / 2, baseY, 0, w / 2, baseY, w * 0.6);
    glow.addColorStop(0, this.rgba(this.color, 0.12 + this.bass * 0.3 + this.beat * 0.15));
    glow.addColorStop(1, this.rgba(this.color, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    for (let i = 0; i < bars; i++) {
      // mirror: low frequencies in the middle
      const pos = Math.abs(i - (bars - 1) / 2) / ((bars - 1) / 2);
      const f = pos * (this.BANDS - 1);
      const i0 = Math.floor(f);
      const i1 = Math.min(this.BANDS - 1, i0 + 1);
      const v = this.bands[i0] + (this.bands[i1] - this.bands[i0]) * (f - i0);
      const idle = 0.03 + 0.02 * Math.sin(this.time * 2 + i * 0.4);
      const bh = Math.max(4, maxH * Math.max(v, idle));
      const x = gap + i * (barW + gap);
      const g = ctx.createLinearGradient(0, baseY - bh, 0, baseY);
      g.addColorStop(0, this.rgba(this.color2, 0.9));
      g.addColorStop(1, this.rgba(this.color, 0.75));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.roundRect(x, baseY - bh, barW, bh, Math.min(barW / 2, 6));
      ctx.fill();
      // reflection
      ctx.fillStyle = this.rgba(this.color, 0.12);
      ctx.fillRect(x, baseY + 4, barW, bh * 0.25);
    }
  }

  // "Аура": big soft color blobs (drawn small and blurred by CSS)
  draw_aurora(ctx, w, h) {
    const blobs = [
      { band: this.bass, color: this.color, sx: 0.23, sy: 0.17, ph: 0 },
      { band: this.mid, color: this.color2, sx: 0.19, sy: 0.23, ph: 2.1 },
      { band: this.high, color: BackgroundVisualizer.shiftHue(this.color, -40), sx: 0.29, sy: 0.13, ph: 4.2 },
      { band: this.energy, color: BackgroundVisualizer.shiftHue(this.color2, 60), sx: 0.13, sy: 0.31, ph: 1.3 }
    ];
    ctx.globalCompositeOperation = 'lighter';
    for (const b of blobs) {
      const x = w * (0.5 + 0.32 * Math.sin(this.time * b.sx + b.ph));
      const y = h * (0.5 + 0.3 * Math.cos(this.time * b.sy + b.ph));
      const r = Math.min(w, h) * (0.35 + b.band * 0.45 + this.beat * 0.08);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, this.rgba(b.color, 0.5 + b.band * 0.4));
      g.addColorStop(1, this.rgba(b.color, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}

window.BG_ANIMATION_PRESETS = BG_ANIMATION_PRESETS;
window.bgVisualizer = new BackgroundVisualizer();
