// Dependency-free 3D projection: eight orbit planes, depth-sorted electrons and
// a draggable global rotation. Acoustic frames modulate the animation locally.
export class AtomExperience {
  constructor({ stars, atom, waveform }) {
    this.stars = stars; this.atom = atom; this.waveform = waveform;
    this.rotation = { x: -0.35, y: 0.3 };
    this.energy = 0; this.target = 0; this.active = false; this.phase = 0;
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.drag = null;
    this.starPoints = Array.from({ length: 260 }, () => ({ x: Math.random(), y: Math.random(), size: 0.3 + Math.random() * 1.3,
      brightness: 0.2 + Math.random() * 0.6, phase: Math.random() * Math.PI * 2, twinkle: Math.random() > 0.88 }));
    this.shells = [
      { radius: 65, tilt: 0.4, turn: 0.2, count: 2, color: '#f3c7ff' },
      { radius: 94, tilt: 1.05, turn: 0.65, count: 8, color: '#a1caff' },
      { radius: 124, tilt: 1.6, turn: -0.4, count: 18, color: '#b7a0ff' },
      { radius: 155, tilt: 0.85, turn: -1.0, count: 32, color: '#76e6ff' },
      { radius: 78, tilt: 1.9, turn: 1.25, count: 6, color: '#ffb7d7' },
      { radius: 108, tilt: 0.65, turn: -1.8, count: 12, color: '#a2f4df' },
      { radius: 138, tilt: 2.2, turn: 0.8, count: 20, color: '#d5b6ff' },
      { radius: 164, tilt: 1.3, turn: 1.7, count: 24, color: '#8bbdff' },
    ];
    atom.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      this.drag = { x: event.clientX, y: event.clientY }; atom.setPointerCapture(event.pointerId);
      atom.classList.add('dragging');
    });
    atom.addEventListener('pointermove', event => {
      if (!this.drag) return;
      this.rotation.y += (event.clientX - this.drag.x) * 0.008;
      this.rotation.x += (event.clientY - this.drag.y) * 0.008;
      this.drag = { x: event.clientX, y: event.clientY };
    });
    const endDrag = () => { this.drag = null; atom.classList.remove('dragging'); };
    atom.addEventListener('pointerup', endDrag); atom.addEventListener('pointercancel', endDrag);
    atom.addEventListener('lostpointercapture', endDrag);
    atom.addEventListener('keydown', event => {
      const keys = { ArrowLeft: [0, -0.12], ArrowRight: [0, 0.12], ArrowUp: [-0.12, 0], ArrowDown: [0.12, 0], Home: null };
      if (!(event.key in keys)) return;
      event.preventDefault();
      if (event.key === 'Home') this.rotation = { x: -0.35, y: 0.3 };
      else { this.rotation.x += keys[event.key][0]; this.rotation.y += keys[event.key][1]; }
    });
    this.last = performance.now();
    const animate = now => {
      const elapsed = Math.min((now - this.last) / 1000, 0.06); this.last = now;
      if (!document.hidden) {
        this.energy += (this.target - this.energy) * 0.12;
        if (!this.reducedMotion) this.phase += elapsed * (0.32 + this.energy * 1.5);
        this.drawStars(now / 1000); this.drawAtom(); this.drawWave(now / 1000);
      }
      this.animation = requestAnimationFrame(animate);
    };
    this.animation = requestAnimationFrame(animate);
  }
  react(frame) {
    this.target = ['silence', 'pause', 'calibrating', 'calibration_needed'].includes(frame.state) ? 0
      : Math.max(0, Math.min(1, (frame.level_dbfs + 65) / 45));
  }
  setActive(value) { this.active = value; if (!value) this.target = 0; }
  getState() { return { shells: this.shells.length, electrons: this.shells.reduce((sum, shell) => sum + shell.count, 0), rotation: { ...this.rotation }, energy: this.energy, active: this.active }; }
  surface(canvas) {
    const { width, height } = canvas.getBoundingClientRect();
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(width * ratio), pixelHeight = Math.round(height * ratio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { canvas.width = pixelWidth; canvas.height = pixelHeight; }
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
    return { context, width, height };
  }
  drawStars(time) {
    const { context: ctx, width, height } = this.surface(this.stars);
    for (const star of this.starPoints) {
      const pulse = star.twinkle && !this.reducedMotion ? 0.6 + Math.sin(time * 0.8 + star.phase) * 0.4 : 1;
      ctx.fillStyle = `rgba(219,230,255,${star.brightness * pulse})`;
      ctx.beginPath(); ctx.arc(star.x * width, star.y * height, star.size, 0, Math.PI * 2); ctx.fill();
      if (star.twinkle && pulse > 0.86) {
        ctx.strokeStyle = `rgba(200,218,255,${(pulse - 0.86) * 1.5})`; ctx.lineWidth = 0.6;
        const x = star.x * width, y = star.y * height;
        ctx.beginPath(); ctx.moveTo(x - 4, y); ctx.lineTo(x + 4, y); ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4); ctx.stroke();
      }
    }
  }
  rotate(point, xAngle, yAngle) {
    const [x, y, z] = point;
    const y1 = y * Math.cos(xAngle) - z * Math.sin(xAngle), z1 = y * Math.sin(xAngle) + z * Math.cos(xAngle);
    return [x * Math.cos(yAngle) + z1 * Math.sin(yAngle), y1, -x * Math.sin(yAngle) + z1 * Math.cos(yAngle)];
  }
  orbit(shell, angle) {
    const radius = shell.radius * (1 + this.energy * 0.13);
    return this.rotate(this.rotate([Math.cos(angle) * radius, Math.sin(angle) * radius, 0], shell.tilt, shell.turn), this.rotation.x, this.rotation.y);
  }
  drawAtom() {
    const { context: ctx, width, height } = this.surface(this.atom);
    const size = Math.min(width, height) / 390;
    const project = ([x, y, z]) => { const depth = 600 / (600 - z); return { x: width / 2 + x * size * depth, y: height / 2 + y * size * depth, z, scale: size * depth }; };
    const items = [];
    this.shells.forEach((shell, index) => {
      for (let step = 0; step < 144; step++) {
        const a = project(this.orbit(shell, step / 144 * Math.PI * 2));
        const b = project(this.orbit(shell, (step + 1) / 144 * Math.PI * 2));
        items.push({ type: 'line', a, b, z: (a.z + b.z) / 2, color: shell.color });
      }
      for (let electron = 0; electron < shell.count; electron++) {
        const angle = electron / shell.count * Math.PI * 2 + this.phase * (index % 2 ? -1 : 1) * (1.4 - index * 0.1);
        const point = project(this.orbit(shell, angle));
        items.push({ type: 'electron', ...point, color: shell.color, radius: 2.1 + (3 - index % 4) * 0.25 });
      }
    });
    // Small spatial cluster at the nucleus, rather than a flat centre icon.
    for (let i = 0; i < 18; i++) {
      const theta = i * 2.39996, vertical = 1 - 2 * (i + 0.5) / 18;
      const r = Math.sqrt(1 - vertical * vertical) * 15;
      const point = project(this.rotate([Math.cos(theta) * r, Math.sin(theta) * r, vertical * 15], this.rotation.x, this.rotation.y));
      items.push({ type: 'nucleus', ...point, color: i % 2 ? '#c7a7ff' : '#f2bce9', radius: 6 });
    }
    const glow = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, 100 * size);
    glow.addColorStop(0, `rgba(127,106,255,${0.17 + this.energy * 0.15})`); glow.addColorStop(1, 'rgba(127,106,255,0)');
    ctx.fillStyle = glow; ctx.fillRect(0, 0, width, height);
    items.sort((a, b) => a.z - b.z);
    for (const item of items) {
      if (item.type === 'line') {
        ctx.globalAlpha = item.z < 0 ? 0.2 : 0.52; ctx.strokeStyle = item.color;
        ctx.lineWidth = size * (0.8 + this.energy * 0.8);
        ctx.beginPath(); ctx.moveTo(item.a.x, item.a.y); ctx.lineTo(item.b.x, item.b.y); ctx.stroke();
      } else {
        ctx.globalAlpha = item.z < 0 ? 0.7 : 1;
        ctx.fillStyle = item.color; ctx.shadowColor = item.color; ctx.shadowBlur = (item.type === 'electron' ? 10 : 13) * size;
        ctx.beginPath(); ctx.arc(item.x, item.y, item.radius * item.scale * (1 + this.energy * 0.25), 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
      }
    }
    ctx.globalAlpha = 1;
  }
  drawWave(time) {
    const { context: ctx, width, height } = this.surface(this.waveform);
    ctx.strokeStyle = '#e4ddff'; ctx.lineWidth = 1.5; ctx.shadowColor = '#b2a0ff'; ctx.shadowBlur = 8;
    ctx.beginPath();
    for (let x = 0; x <= width; x += 2) {
      const envelope = Math.sin(x / width * Math.PI) ** 1.8;
      const movement = this.reducedMotion ? 0 : time * (2 + this.energy * 3);
      const wave = Math.sin(x * 0.095 - movement) * Math.sin(x * 0.032 + movement * 0.4);
      const amplitude = Math.min(height / 2 - 5, 16 + this.energy * 24);
      const y = height / 2 + wave * envelope * amplitude;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.shadowBlur = 0;
  }
  destroy() { cancelAnimationFrame(this.animation); }
}
