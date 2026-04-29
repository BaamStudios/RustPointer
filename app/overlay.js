'use strict';

(() => {
  const canvas = document.getElementById('overlay');
  const ctx = canvas.getContext('2d');

  const FADE_MS = 1500;
  const TRAIL_LEN = 18;
  const POINTER_RADIUS = 20;

  let dpr = window.devicePixelRatio || 1;

  const state = {
    pressed: false,
    last: null,
    trail: [],
    fadeStart: 0
  };

  function resize() {
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  function pushTrail(p) {
    state.trail.push({ x: p.x, y: p.y, t: performance.now() });
    if (state.trail.length > TRAIL_LEN) state.trail.shift();
  }

  function drawPointer(px, py, alpha) {
    const grad = ctx.createRadialGradient(px, py, 0, px, py, POINTER_RADIUS * 1.6);
    grad.addColorStop(0, `rgba(255, 240, 200, ${0.95 * alpha})`);
    grad.addColorStop(0.35, `rgba(255, 60, 60, ${0.85 * alpha})`);
    grad.addColorStop(0.7, `rgba(255, 30, 30, ${0.45 * alpha})`);
    grad.addColorStop(1, `rgba(255, 0, 0, 0)`);

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(px, py, POINTER_RADIUS * 1.6, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = `rgba(255, 60, 60, ${alpha})`;
    ctx.beginPath();
    ctx.arc(px, py, POINTER_RADIUS * 0.6, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = `rgba(255, 255, 255, ${0.85 * alpha})`;
    ctx.beginPath();
    ctx.arc(px, py, POINTER_RADIUS * 0.22, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawTrail(alphaFactor) {
    if (state.trail.length < 2) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 1; i < state.trail.length; i++) {
      const a = state.trail[i - 1];
      const b = state.trail[i];
      const f = i / state.trail.length;
      const opacity = f * 0.55 * alphaFactor;
      ctx.strokeStyle = `rgba(255, 80, 80, ${opacity})`;
      ctx.lineWidth = 2 + f * 6;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function clear() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function render() {
    requestAnimationFrame(render);
    clear();

    const now = performance.now();
    let alpha = 0;

    if (state.pressed) {
      alpha = 1;
    } else if (state.fadeStart > 0) {
      const elapsed = now - state.fadeStart;
      if (elapsed >= FADE_MS) {
        state.trail.length = 0;
        state.fadeStart = 0;
        return;
      }
      alpha = 1 - elapsed / FADE_MS;
    } else {
      return;
    }

    drawTrail(alpha);
    if (state.last) drawPointer(state.last.x, state.last.y, alpha);
  }
  requestAnimationFrame(render);

  function toScreen(p) {
    return {
      x: p.x * window.innerWidth,
      y: p.y * window.innerHeight
    };
  }

  function onCursor(payload) {
    if (!payload) return;
    if (payload.pressed) {
      const s = toScreen(payload);
      state.last = s;
      state.pressed = true;
      state.fadeStart = 0;
      pushTrail(s);
    } else {
      state.pressed = false;
      state.fadeStart = performance.now();
    }
  }

  if (window.presenter && window.presenter.onCursor) {
    window.presenter.onCursor(onCursor);
    window.presenter.notifyOverlayReady && window.presenter.notifyOverlayReady();
  }
})();
