/** A procedural amber energy sphere. No images, external assets, or telemetry. */
export function mountEnergyOrb(orb, canvas) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  orb.classList.add("energy-ready");
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let width = 1,
    ratio = 1,
    frame,
    last = 0;
  const tau = Math.PI * 2;
  function size() {
    cancelAnimationFrame(frame);
    const r = orb.getBoundingClientRect();
    width = Math.max(1, r.width);
    ratio = Math.min(devicePixelRatio || 1, 1.7);
    canvas.width = Math.round(width * ratio);
    canvas.height = canvas.width;
    draw(performance.now(), true);
  }
  function point(lat, lon, t, energy) {
    const ripple =
      1 +
      0.055 * Math.sin(lon * 7 + lat * 5 + t * 1.6) +
      0.025 * Math.sin(lon * 19 - lat * 11 - t * 2.2) +
      energy * 0.045 * Math.sin(lon * 11 + lat * 6 + t * 8);
    const x = Math.cos(lat) * Math.cos(lon) * ripple,
      y = Math.sin(lat) * ripple,
      z = Math.cos(lat) * Math.sin(lon) * ripple;
    const angle = t * 0.17,
      ca = Math.cos(angle),
      sa = Math.sin(angle),
      xx = x * ca + z * sa,
      zz = -x * sa + z * ca;
    const tilt = -0.3,
      yy = y * Math.cos(tilt) - zz * Math.sin(tilt),
      depth = y * Math.sin(tilt) + zz * Math.cos(tilt);
    const perspective = 1 / (1 - depth * 0.15);
    return { x: xx * perspective, y: yy * perspective, z: depth };
  }
  function draw(now, force = false) {
    if (document.hidden) return;
    if (
      !force &&
      now - last <
        (document.documentElement.dataset.assistantState === "speaking" ||
        document.documentElement.dataset.assistantState === "listening"
          ? 33
          : 50)
    ) {
      frame = requestAnimationFrame(draw);
      return;
    }
    last = now;
    const frozen = motion.matches,
      t = frozen ? 2 : now / 1000;
    const state = document.documentElement.dataset.assistantState;
    const voice = Number(orb.style.getPropertyValue("--voice-level")) || 0,
      mic = Number(orb.style.getPropertyValue("--mic-level")) || 0;
    const energy = frozen
      ? 0
      : state === "speaking"
        ? voice
        : state === "listening"
          ? mic
          : state === "thinking"
            ? 0.12
            : 0;
    const radius = width * 0.36,
      center = width / 2;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, width);
    ctx.globalCompositeOperation = "source-over";
    const glow = ctx.createRadialGradient(
      center,
      center,
      0,
      center,
      center,
      width * 0.49,
    );
    glow.addColorStop(0, `rgba(255,174,44,${0.13 + energy * 0.15})`);
    glow.addColorStop(0.45, "rgba(235,99,10,.08)");
    glow.addColorStop(1, "rgba(110,35,0,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, width);
    ctx.globalCompositeOperation = "lighter";
    ctx.lineWidth = 0.6;
    ctx.shadowColor = "#ff9b2f";
    ctx.shadowBlur = 0;
    function trace(getPoint, steps, alpha) {
      ctx.strokeStyle = `rgba(255,166,66,${alpha})`;
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const p = getPoint(i / steps);
        const x = center + p.x * radius,
          y = center + p.y * radius;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    for (let i = 0; i < 25; i++) {
      const lon = (i / 25) * tau;
      trace((a) => point((a - 0.5) * Math.PI, lon, t, energy), 65, 0.56);
    }
    for (let i = 1; i < 20; i++) {
      const lat = (i / 20 - 0.5) * Math.PI;
      trace((a) => point(lat, a * tau, t, energy), 90, 0.46);
    }
    ctx.shadowBlur = 0;
    for (let i = 0; i < 620; i++) {
      const seed = Math.sin(i * 127.1 + 311.7) * 43758.5453,
        f = seed - Math.floor(seed);
      const lat = Math.asin(((i + 0.5) / 620) * 2 - 1),
        lon = i * 2.3999632297;
      const p = point(lat, lon, t, energy);
      const sparkle = 0.4 + 0.6 * Math.sin(t * 1.2 + i * 0.7) ** 2;
      ctx.fillStyle = `rgba(255,${Math.round(133 + f * 93)},${Math.round(40 + f * 65)},${(0.15 + (0.7 * (p.z + 1)) / 2) * sparkle})`;
      const dot = (0.7 + f * 1.15) * (1 + energy * 0.8);
      ctx.fillRect(center + p.x * radius, center + p.y * radius, dot, dot);
      if (i % 11 === 0 && p.z > -0.2) {
        const length = 1.07 + f * 0.16 + energy * 0.08;
        ctx.strokeStyle = `rgba(255,145,46,${0.23 + f * 0.3})`;
        ctx.beginPath();
        ctx.moveTo(center + p.x * radius, center + p.y * radius);
        ctx.lineTo(
          center + p.x * radius * length,
          center + p.y * radius * length,
        );
        ctx.stroke();
      }
    }
    const coreGlow = ctx.createRadialGradient(
      center,
      center,
      0,
      center,
      center,
      radius * 0.42,
    );
    coreGlow.addColorStop(0, "rgba(255,232,128,.20)");
    coreGlow.addColorStop(0.3, "rgba(255,167,33,.13)");
    coreGlow.addColorStop(1, "rgba(255,85,0,0)");
    ctx.fillStyle = coreGlow;
    ctx.fillRect(0, 0, width, width);
    // Entangled molten filaments at the core, inspired by the supplied image.
    ctx.shadowBlur = 8 + energy * 6;
    ctx.lineWidth = 0.85;
    for (let j = 0; j < 5; j++) {
      ctx.strokeStyle = `rgba(255,${190 + j * 9},${68 + j * 14},${0.5 + energy * 0.2})`;
      ctx.beginPath();
      for (let i = 0; i <= 110; i++) {
        const a = (i / 110) * tau,
          spin = t * (0.5 + j * 0.1),
          r = radius * (0.2 + j * 0.022) * (1 + 0.3 * Math.sin(a * 3 + spin));
        const x = Math.cos(a + spin) * r,
          y = Math.sin(a * 2 + spin * 0.6) * r * 0.75;
        const px = center + x * Math.cos(j * 0.6) - y * Math.sin(j * 0.6),
          py = center + x * Math.sin(j * 0.6) + y * Math.cos(j * 0.6);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    if (!motion.matches) frame = requestAnimationFrame(draw);
  }
  const resize = new ResizeObserver(size);
  resize.observe(orb);
  motion.addEventListener("change", () => {
    cancelAnimationFrame(frame);
    draw(performance.now(), true);
  });
  document.addEventListener("visibilitychange", () => {
    cancelAnimationFrame(frame);
    if (!document.hidden) draw(performance.now(), true);
  });
  const stateObserver = new MutationObserver(() => {
    if (motion.matches) draw(performance.now(), true);
  });
  stateObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-assistant-state"],
  });
  window.addEventListener(
    "pagehide",
    () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      stateObserver.disconnect();
    },
    { once: true },
  );
  size();
}
