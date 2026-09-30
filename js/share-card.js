// Draws a share card (1080 x 1350) from a small summary each screen provides.
// Always uses the light palette so it looks right in any chat app.

const W = 1080;
const H = 1350;
const THEME = {
  train: { bg: "#EDF7F1", tint: "#D8EFE2", accent: "#3E8A66", deep: "#1F5A40", line: "#86C9A6" },
  flight: { bg: "#EDF3FB", tint: "#DCEAF8", accent: "#3F6FA8", deep: "#1F3F66", line: "#9DBBE0" },
};
const INK = "#2A2D3A";
const MUTED = "#6C6F7E";
const HAIR = "#ECEAE4";
const TONES = {
  ok: ["#D8EFE2", "#1F5A40"],
  early: ["#D8EFE2", "#1F5A40"],
  good: ["#D8EFE2", "#1F5A40"],
  late: ["#FCE7D6", "#8A4A1C"],
  warn: ["#FCE7D6", "#8A4A1C"],
  bad: ["#F8DFE3", "#8C2F42"],
  info: ["#ECE8F7", "#4A3F7A"],
  accent: ["#1F5A40", "#FFFFFF"],
};
const PLANE_D =
  "M12 2c.9 0 1.4 1.8 1.4 3.2v4.3l7.6 4.5v2.2l-7.6-2.5v4.6l2.5 2v1.7l-3.9-1.2-3.9 1.2v-1.7l2.5-2v-4.6L3 16.2V14l7.6-4.5V5.2C10.6 3.8 11.1 2 12 2z";
let planePath = null;
const PLANE_PATH = () => (planePath ??= new Path2D(PLANE_D));
const DISPLAY = (size, weight = 400) => `${weight} ${size}px Fraunces, Georgia, serif`;
const BODY = (size, weight = 600) => `${weight} ${size}px "Plus Jakarta Sans", system-ui, sans-serif`;

export async function renderShareImage(summary) {
  try {
    await Promise.all([
      document.fonts.load(DISPLAY(100)),
      document.fonts.load(BODY(40, 500)),
      document.fonts.load(BODY(40, 700)),
      document.fonts.load(BODY(40, 800)),
    ]);
  } catch {
    /* system fonts still look fine */
  }
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const t = THEME[summary.mode];

  // background with a soft glow
  ctx.fillStyle = t.bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.85, 80, 20, W * 0.85, 80, 700);
  glow.addColorStop(0, t.tint);
  glow.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // heading
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = t.deep;
  ctx.font = BODY(42, 800);
  ctx.fillText(summary.kicker, 72, 128);
  ctx.fillStyle = MUTED;
  ctx.font = BODY(34, 500);
  ctx.fillText(fit(ctx, summary.subtitle || "", W - 144), 72, 178);

  // card
  const card = { x: 56, y: 226, w: W - 112, h: 980 };
  ctx.save();
  ctx.shadowColor = "rgba(42,45,58,0.10)";
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 12;
  ctx.fillStyle = "#FFFFFF";
  round(ctx, card.x, card.y, card.w, card.h, 56);
  ctx.fill();
  ctx.restore();

  if (summary.mode === "train") drawTrain(ctx, summary, t, card);
  else drawFlight(ctx, summary, t, card);

  // footer
  const fy = 1286;
  ctx.fillStyle = t.deep;
  round(ctx, 72, fy - 50, 72, 72, 22);
  ctx.fill();
  ctx.save();
  ctx.translate(84, fy - 38);
  ctx.scale(2, 2);
  ctx.fillStyle = "#FFFFFF";
  if (summary.mode === "flight") ctx.fill(PLANE_PATH());
  else trainMark(ctx);
  ctx.restore();
  ctx.fillStyle = t.deep;
  ctx.font = BODY(34, 800);
  ctx.fillText("Live on Track", 166, fy - 14);
  ctx.fillStyle = MUTED;
  ctx.font = BODY(28, 500);
  ctx.fillText("parth8.github.io/track", 166, fy + 22);
  if (summary.updated) {
    ctx.textAlign = "right";
    ctx.fillText(summary.updated, W - 72, fy + 22);
    ctx.textAlign = "left";
  }

  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
}

function drawTrain(ctx, s, t, card) {
  const x = card.x + 56;
  const right = card.x + card.w - 56;

  ctx.fillStyle = t.accent;
  ctx.font = BODY(34, 700);
  ctx.fillText(s.eyebrow, x, card.y + 92);

  ctx.fillStyle = t.deep;
  const placeSize = shrink(ctx, s.place, right - x, (n) => DISPLAY(n), 92, 52);
  ctx.font = DISPLAY(placeSize);
  ctx.fillText(s.place, x, card.y + 190);

  ctx.font = DISPLAY(200, 300);
  ctx.fillText(s.time || "--:--", x - 6, card.y + 380);

  ctx.textAlign = "right";
  ctx.fillStyle = MUTED;
  ctx.font = BODY(34, 500);
  ctx.fillText(s.whenTop || "", right, card.y + 300);
  ctx.fillStyle = INK;
  ctx.font = BODY(46, 800);
  ctx.fillText(s.whenBottom || "", right, card.y + 358);
  ctx.textAlign = "left";

  let y = card.y + 420;
  if (s.chip) {
    y = chip(ctx, s.chip.text, s.chip.cls, x, y) + 24;
  } else y += 20;

  // journey progress
  const py = y + 40;
  ctx.lineCap = "round";
  ctx.strokeStyle = HAIR;
  ctx.lineWidth = 8;
  line(ctx, x, py, right, py);
  const fx = x + (right - x) * Math.min(1, Math.max(0, s.progress.fraction));
  ctx.strokeStyle = t.line;
  line(ctx, x, py, fx, py);
  const dots = s.progress.dots || [];
  dots.forEach((d, i) => {
    const dx = x + ((right - x) * i) / Math.max(1, dots.length - 1);
    const r = d === "c" ? 16 : d === "m" ? 14 : 8;
    ctx.beginPath();
    ctx.arc(dx, py, r, 0, Math.PI * 2);
    ctx.fillStyle = d === "c" ? t.accent : d === "m" ? t.deep : d === "p" ? t.line : "#FFFFFF";
    ctx.fill();
    if (!d) {
      ctx.strokeStyle = HAIR;
      ctx.lineWidth = 4;
      ctx.stroke();
    }
  });
  ctx.fillStyle = MUTED;
  ctx.font = BODY(28, 600);
  ctx.fillText(s.progress.left, x, py + 58);
  ctx.textAlign = "right";
  ctx.fillText(s.progress.right, right, py + 58);
  ctx.textAlign = "center";
  ctx.fillStyle = INK;
  ctx.font = BODY(30, 800);
  ctx.fillText(s.progress.middle, (x + right) / 2, py + 58);
  ctx.textAlign = "left";

  // now panel
  const ny = py + 96;
  const nh = card.y + card.h - 56 - ny;
  ctx.fillStyle = t.deep;
  round(ctx, x, ny, right - x, nh, 36);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.font = BODY(30, 700);
  ctx.fillText(s.nowLead || "Now", x + 40, ny + 62);
  ctx.fillStyle = "#FFFFFF";
  ctx.font = BODY(36, 500);
  wrap(ctx, s.now || "", x + 40, ny + 116, right - x - 80, 50, Math.max(2, Math.floor((nh - 90) / 50)));
}

function drawFlight(ctx, s, t, card) {
  const x = card.x + 56;
  const right = card.x + card.w - 56;

  // airports and the arc between them
  ctx.fillStyle = t.deep;
  ctx.font = DISPLAY(118);
  ctx.fillText(s.from, x - 4, card.y + 170);
  ctx.textAlign = "right";
  ctx.fillText(s.to, right + 4, card.y + 170);
  ctx.fillStyle = MUTED;
  ctx.font = BODY(32, 600);
  ctx.fillText(fit(ctx, s.toCity, 300), right, card.y + 222);
  ctx.textAlign = "left";
  ctx.fillText(fit(ctx, s.fromCity, 300), x, card.y + 222);

  ctx.font = DISPLAY(118);
  const a = { x: x + ctx.measureText(s.from).width + 44, y: card.y + 132 };
  const b = { x: right - ctx.measureText(s.to).width - 44, y: card.y + 132 };
  const c = { x: (a.x + b.x) / 2, y: card.y + 40 };
  const q = (k) => ({
    x: (1 - k) * (1 - k) * a.x + 2 * (1 - k) * k * c.x + k * k * b.x,
    y: (1 - k) * (1 - k) * a.y + 2 * (1 - k) * k * c.y + k * k * b.y,
  });
  ctx.lineCap = "round";
  ctx.setLineDash([2, 16]);
  ctx.strokeStyle = t.line;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.quadraticCurveTo(c.x, c.y, b.x, b.y);
  ctx.stroke();
  ctx.setLineDash([]);
  const f = Math.min(1, Math.max(0, s.fraction || 0));
  ctx.strokeStyle = t.accent;
  ctx.beginPath();
  for (let k = 0; k <= f + 0.0001; k += 0.02) {
    const p = q(Math.min(k, f));
    if (k === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  if (f > 0) ctx.stroke();
  const p = q(f);
  const p2 = q(Math.min(1, f + 0.01));
  const p1 = q(Math.max(0, f - 0.01));
  const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x) + Math.PI / 2;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.arc(0, 0, 38, 0, Math.PI * 2);
  ctx.fillStyle = t.tint;
  ctx.fill();
  ctx.scale(2.6, 2.6);
  ctx.translate(-12, -12);
  ctx.fillStyle = t.deep;
  ctx.fill(PLANE_PATH());
  ctx.restore();

  // phase panel
  const [bg, fg] = TONES[s.tone] || [t.tint, t.deep];
  const py = card.y + 272;
  const ph = 300;
  ctx.fillStyle = bg;
  round(ctx, x, py, right - x, ph, 40);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.font = BODY(32, 700);
  ctx.fillText(s.lead || "", x + 44, py + 68);
  const bigSize = shrink(ctx, s.big || "", right - x - 88, (n) => DISPLAY(n, 300), 150, 80);
  ctx.font = DISPLAY(bigSize, 300);
  ctx.fillText(s.big || "", x + 38, py + 68 + bigSize * 0.95);
  ctx.font = BODY(32, 600);
  ctx.fillText(fit(ctx, s.sub || "", right - x - 88), x + 44, py + ph - 38);

  // tiles
  const tiles = (s.tiles || []).slice(0, 3);
  if (tiles.length) {
    const gap = 24;
    const tw = (right - x - gap * (tiles.length - 1)) / tiles.length;
    const ty = py + ph + 36;
    const th = card.y + card.h - 56 - ty;
    tiles.forEach((tile, i) => {
      const tx = x + i * (tw + gap);
      ctx.fillStyle = t.bg;
      round(ctx, tx, ty, tw, th, 32);
      ctx.fill();
      const size = shrink(ctx, tile.value, tw - 64, (n) => BODY(n, 800), 64, 34);
      const top = ty + (th - (28 + 18 + 64)) / 2 + 24; // same label line for every tile
      ctx.fillStyle = t.accent;
      ctx.font = BODY(28, 700);
      ctx.fillText(tile.label, tx + 32, top);
      ctx.fillStyle = INK;
      ctx.font = BODY(size, 800);
      ctx.fillText(tile.value, tx + 32, top + 18 + 64 * 0.9);
    });
  }
}

/* ---------------- drawing helpers ---------------- */

function chip(ctx, text, cls, x, y) {
  const [bg, fg] = TONES[cls] || TONES.info;
  ctx.font = BODY(32, 700);
  const w = ctx.measureText(text).width + 56;
  ctx.fillStyle = bg;
  round(ctx, x, y, w, 64, 32);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.fillText(text, x + 28, y + 43);
  return y + 64;
}

function trainMark(ctx) {
  // a small train face, 24 x 24 units
  round(ctx, 6, 2, 12, 15, 4);
  ctx.fill();
  ctx.fillStyle = "#1F5A40";
  round(ctx, 8, 5, 8, 5, 1.5);
  ctx.fill();
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(6, 19, 12, 1.8);
  ctx.fillRect(7, 17, 1.8, 3);
  ctx.fillRect(15.2, 17, 1.8, 3);
}

function round(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function fit(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

function shrink(ctx, text, max, font, start, min) {
  for (let n = start; n > min; n -= 4) {
    ctx.font = font(n);
    if (ctx.measureText(text).width <= max) return n;
  }
  return min;
}

function wrap(ctx, text, x, y, max, lh, maxLines) {
  const words = text.split(/\s+/);
  let lineText = "";
  let lines = 0;
  for (let i = 0; i < words.length; i++) {
    const test = lineText ? `${lineText} ${words[i]}` : words[i];
    if (ctx.measureText(test).width > max && lineText) {
      lines += 1;
      if (lines === maxLines) {
        ctx.fillText(fit(ctx, `${lineText} ${words.slice(i).join(" ")}`, max), x, y);
        return;
      }
      ctx.fillText(lineText, x, y);
      y += lh;
      lineText = words[i];
    } else lineText = test;
  }
  if (lineText) ctx.fillText(lineText, x, y);
}
