/* ==========================================================================
   Easter egg: 10 quick clicks on the settings icon unlock the "Секреты" section.
   First secret: the New Year mode with snow falling over the whole app.
   ========================================================================== */

class Snowfall {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'snow-canvas';
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.flakes = [];
    this.density = 80;
    this.running = false;
    this.last = 0;
    this.time = 0;
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.running) requestAnimationFrame((t) => this.frame(t));
    });
    this.resize();
  }

  resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  setDensity(value) {
    this.density = Math.max(10, Math.min(250, Number(value) || 80));
  }

  makeFlake(anywhere) {
    const r = 0.8 + Math.pow(Math.random(), 2.2) * 3.4;   // mostly small, a few big ones
    return {
      x: Math.random() * this.canvas.width,
      y: anywhere ? Math.random() * this.canvas.height : -10 - Math.random() * 60,
      r,
      speed: 18 + r * 14 + Math.random() * 12,               // bigger flakes fall faster
      drift: 8 + Math.random() * 18,
      phase: Math.random() * Math.PI * 2,
      alpha: 0.45 + Math.random() * 0.5
    };
  }

  start() {
    this.canvas.style.display = 'block';
    if (this.running) return;
    this.running = true;
    this.flakes = [];
    this.fillScreen = true;   // first frame: spread flakes over the whole window
    requestAnimationFrame((t) => this.frame(t));
  }

  stop() {
    this.running = false;
    this.canvas.style.display = 'none';
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  frame(now) {
    if (!this.running || document.hidden) return;
    const dt = Math.min(0.05, (now - (this.last || now)) / 1000);
    this.last = now;
    this.time += dt;

    const { ctx, canvas } = this;
    const target = Math.round(this.density * (canvas.width * canvas.height) / (1400 * 860));
    while (this.flakes.length < target) this.flakes.push(this.makeFlake(this.fillScreen));
    if (this.flakes.length > target) this.flakes.length = target;
    this.fillScreen = false;

    const wind = Math.sin(this.time * 0.15) * 14;           // slow gusts
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < this.flakes.length; i++) {
      const f = this.flakes[i];
      f.y += f.speed * dt;
      f.x += (wind + Math.sin(this.time * 1.2 + f.phase) * f.drift) * dt;
      if (f.y > canvas.height + 10 || f.x < -20 || f.x > canvas.width + 20) {
        this.flakes[i] = this.makeFlake(false);
        continue;
      }
      ctx.globalAlpha = f.alpha;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame((t) => this.frame(t));
  }
}

class SecretFeatures {
  constructor() {
    this.clicks = 0;
    this.lastClickAt = 0;
    this.snow = new Snowfall();
  }

  get config() {
    const app = window.appController;
    if (!app || !app.config) return {};
    if (!app.config.settings) app.config.settings = {};
    if (!app.config.settings.secrets) app.config.settings.secrets = { unlocked: false, snow: false, snowDensity: 80 };
    return app.config.settings.secrets;
  }

  save(patch) {
    Object.assign(this.config, patch);
    window.api.library.saveConfig(window.appController.config).catch?.(() => {});
  }

  init() {
    const icon = document.getElementById('settings-brand-icon');
    icon?.addEventListener('click', () => this.onIconClick(icon));

    document.getElementById('secret-snow-toggle')?.addEventListener('change', (e) => {
      this.save({ snow: e.target.checked });
      this.applySnow();
    });
    document.getElementById('secret-snow-density')?.addEventListener('input', (e) => {
      const value = parseInt(e.target.value, 10);
      this.save({ snowDensity: value });
      this.snow.setDensity(value);
      this.updateUI();
    });
    document.getElementById('btn-hide-secrets')?.addEventListener('click', () => {
      this.save({ unlocked: false });
      this.updateUI();
      window.appController?.switchSettingsTab('folders');
      window.appController?.showToast('Секретный раздел спрятан. Вы знаете, как его найти 😉', 'info');
    });

    this.applySnow();
    this.updateUI();
  }

  onIconClick(icon) {
    const now = Date.now();
    this.clicks = now - this.lastClickAt < 1500 ? this.clicks + 1 : 1;
    this.lastClickAt = now;

    icon.classList.remove('secret-spin');
    void icon.offsetWidth;          // restart the animation
    icon.classList.add('secret-spin');

    if (this.config.unlocked) {
      if (this.clicks >= 3) {
        this.clicks = 0;
        window.appController?.switchSettingsTab('secrets');
      }
      return;
    }

    const left = 10 - this.clicks;
    if (left <= 0) {
      this.clicks = 0;
      this.save({ unlocked: true });
      document.querySelectorAll('.toast.secret-hint').forEach(t => t.remove());
      this.updateUI();
      window.appController?.switchSettingsTab('secrets');
      window.appController?.showToast('🎉 Секретные настройки открыты!', 'success');
    } else if (this.clicks >= 6) {
      this.showHint(`Ещё ${left}…`);
    }
  }

  // One hint toast at a time: the next click replaces the previous one
  showHint(text) {
    document.querySelectorAll('.toast.secret-hint').forEach(t => t.remove());
    window.appController?.showToast(text, 'info', 1200);
    const toasts = document.querySelectorAll('#toast-container .toast');
    const latest = toasts[toasts.length - 1];
    if (latest) latest.classList.add('secret-hint');
  }

  applySnow() {
    this.snow.setDensity(this.config.snowDensity || 80);
    if (this.config.snow) this.snow.start();
    else this.snow.stop();
  }

  updateUI() {
    const cfg = this.config;
    const nav = document.getElementById('settings-nav-secrets');
    if (nav) nav.style.display = cfg.unlocked ? '' : 'none';
    const toggle = document.getElementById('secret-snow-toggle');
    if (toggle) toggle.checked = !!cfg.snow;
    const slider = document.getElementById('secret-snow-density');
    const density = cfg.snowDensity || 80;
    if (slider) slider.value = density;
    const label = document.getElementById('secret-snow-density-label');
    if (label) label.textContent = density < 60 ? 'Лёгкий снег' : density < 130 ? 'Снегопад' : 'Метель';
    window.appController?.refreshSettingsRanges?.();
  }
}

window.secretFeatures = new SecretFeatures();
