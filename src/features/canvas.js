// features/canvas.js — composited PNG cards (rank/level, welcome, quote) using
// @napi-rs/canvas (prebuilt native bindings, no system build toolchain needed unlike
// node-canvas). All drawing is local/deterministic — no external image API involved.
const { createCanvas, loadImage } = require('@napi-rs/canvas');

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fitText(ctx, text, maxWidth, startSize, minSize, fontWeight = 'bold') {
  let size = startSize;
  while (size > minSize) {
    ctx.font = `${fontWeight} ${size}px sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 2;
  }
  return size;
}

async function safeLoadImage(source) {
  try {
    return await loadImage(source);
  } catch {
    return null;
  }
}

/**
 * Rank/level card — ties into leveling.js's profile(): shows avatar, name, level,
 * and an XP progress bar toward the next level.
 */
async function rankCard({ name, avatarUrl, level, xp, xpIntoLevel, xpToNextLevel, rank }) {
  const W = 900, H = 300;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#1f1147');
  grad.addColorStop(1, '#3d1a5b');
  ctx.fillStyle = grad;
  roundRect(ctx, 0, 0, W, H, 24);
  ctx.fill();

  // avatar
  const avSize = 200, avX = 50, avY = 50;
  ctx.save();
  ctx.beginPath();
  ctx.arc(avX + avSize / 2, avY + avSize / 2, avSize / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  const avatar = avatarUrl ? await safeLoadImage(avatarUrl) : null;
  if (avatar) {
    ctx.drawImage(avatar, avX, avY, avSize, avSize);
  } else {
    ctx.fillStyle = '#5b3a8e';
    ctx.fillRect(avX, avY, avSize, avSize);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 90px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((name || '?').charAt(0).toUpperCase(), avX + avSize / 2, avY + avSize / 2 + 8);
  }
  ctx.restore();
  ctx.strokeStyle = '#ffffff33';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(avX + avSize / 2, avY + avSize / 2, avSize / 2, 0, Math.PI * 2);
  ctx.stroke();

  // name
  const textX = 290;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff';
  const nameSize = fitText(ctx, name || 'User', W - textX - 40, 46, 26);
  ctx.font = `bold ${nameSize}px sans-serif`;
  ctx.fillText(name || 'User', textX, 100);

  // level / rank
  ctx.font = '28px sans-serif';
  ctx.fillStyle = '#c9b6f0';
  ctx.fillText(`Level ${level}${rank ? `  •  Rank #${rank}` : ''}`, textX, 140);

  // xp bar
  const barX = textX, barY = 180, barW = W - textX - 60, barH = 34;
  ctx.fillStyle = '#00000055';
  roundRect(ctx, barX, barY, barW, barH, 17);
  ctx.fill();
  const total = xpIntoLevel + xpToNextLevel;
  const pct = total > 0 ? Math.min(1, xpIntoLevel / total) : 1;
  const fillGrad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
  fillGrad.addColorStop(0, '#7c3aed');
  fillGrad.addColorStop(1, '#c026d3');
  ctx.fillStyle = fillGrad;
  roundRect(ctx, barX, barY, Math.max(barH, barW * pct), barH, 17);
  ctx.fill();

  ctx.fillStyle = '#e6d9ff';
  ctx.font = '20px sans-serif';
  ctx.fillText(`${xpIntoLevel} / ${total} XP to level ${level + 1}`, barX, barY + barH + 30);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#ffffffaa';
  ctx.font = '18px sans-serif';
  ctx.fillText(`${xp} total XP`, barX + barW, barY + barH + 30);

  return canvas.toBuffer('image/png');
}

/** Welcome card — avatar, name, and group name over a gradient banner. */
async function welcomeCard({ name, avatarUrl, groupName, memberCount }) {
  const W = 900, H = 400;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#0f2027');
  grad.addColorStop(0.5, '#203a43');
  grad.addColorStop(1, '#2c5364');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  const avSize = 180, avX = W / 2 - avSize / 2, avY = 50;
  ctx.save();
  ctx.beginPath();
  ctx.arc(avX + avSize / 2, avY + avSize / 2, avSize / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  const avatar = avatarUrl ? await safeLoadImage(avatarUrl) : null;
  if (avatar) {
    ctx.drawImage(avatar, avX, avY, avSize, avSize);
  } else {
    ctx.fillStyle = '#3d6b7a';
    ctx.fillRect(avX, avY, avSize, avSize);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 80px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((name || '?').charAt(0).toUpperCase(), avX + avSize / 2, avY + avSize / 2 + 8);
  }
  ctx.restore();
  ctx.strokeStyle = '#ffffff55';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(avX + avSize / 2, avY + avSize / 2, avSize / 2, 0, Math.PI * 2);
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff';
  const nameSize = fitText(ctx, `Welcome, ${name || 'friend'}!`, W - 80, 44, 24);
  ctx.font = `bold ${nameSize}px sans-serif`;
  ctx.fillText(`Welcome, ${name || 'friend'}!`, W / 2, 280);

  ctx.font = '26px sans-serif';
  ctx.fillStyle = '#bcd9e0';
  const sub = groupName ? `${groupName}${memberCount ? ` • Member #${memberCount}` : ''}` : '';
  if (sub) ctx.fillText(sub, W / 2, 325);

  return canvas.toBuffer('image/png');
}

/** Quote card — styled text on a dark gradient, for "make a quote image of this" requests. */
async function quoteCard({ text, author }) {
  const W = 900, H = 500;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#0d0d0d');
  grad.addColorStop(1, '#232323');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = '#ffffff22';
  ctx.font = 'bold 160px serif';
  ctx.textAlign = 'left';
  ctx.fillText('“', 40, 160);

  // word-wrap the quote text
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  const maxWidth = W - 140;
  let size = 46;
  let lines = [];
  const words = String(text || '').split(/\s+/);
  while (size > 24) {
    ctx.font = `600 ${size}px sans-serif`;
    lines = [];
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    if (lines.length <= 6) break;
    size -= 2;
  }
  const lineHeight = size * 1.35;
  const startY = H / 2 - (lines.length * lineHeight) / 2;
  lines.forEach((line, i) => ctx.fillText(line, W / 2, startY + i * lineHeight));

  if (author) {
    ctx.font = '28px sans-serif';
    ctx.fillStyle = '#aaaaaa';
    ctx.fillText(`— ${author}`, W / 2, H - 50);
  }

  return canvas.toBuffer('image/png');
}

/** Ship/compatibility card — two avatars, a heart, and a % score. Purely for fun. */
async function shipCard({ nameA, avatarUrlA, nameB, avatarUrlB, percent }) {
  const W = 900, H = 400;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#3a0d2e');
  grad.addColorStop(1, '#7a1e4a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  const avSize = 200, avY = 60;
  async function drawAvatar(url, cx, fallbackLetter) {
    const x = cx - avSize / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, avY + avSize / 2, avSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    const img = url ? await safeLoadImage(url) : null;
    if (img) {
      ctx.drawImage(img, x, avY, avSize, avSize);
    } else {
      ctx.fillStyle = '#5b2a4e';
      ctx.fillRect(x, avY, avSize, avSize);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 90px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(fallbackLetter, cx, avY + avSize / 2 + 8);
    }
    ctx.restore();
    ctx.strokeStyle = '#ffffff55';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, avY + avSize / 2, avSize / 2, 0, Math.PI * 2);
    ctx.stroke();
  }
  await drawAvatar(avatarUrlA, 230, (nameA || '?').charAt(0).toUpperCase());
  await drawAvatar(avatarUrlB, W - 230, (nameB || '?').charAt(0).toUpperCase());

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 90px sans-serif';
  ctx.fillStyle = '#ff5c8a';
  ctx.fillText('💗', W / 2, avY + avSize / 2);

  ctx.font = 'bold 64px sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`${percent}%`, W / 2, avY + avSize + 55);

  ctx.font = '26px sans-serif';
  ctx.fillStyle = '#f0c6d8';
  const namesLine = fitText(ctx, `${nameA || 'A'} × ${nameB || 'B'}`, W - 80, 30, 18);
  ctx.font = `${namesLine}px sans-serif`;
  ctx.fillText(`${nameA || 'A'} × ${nameB || 'B'}`, W / 2, avY + avSize + 100);

  return canvas.toBuffer('image/png');
}

/** Visual leaderboard — top N entries as ranked rows with bars proportional to the top score. */
async function leaderboardCard({ title, entries }) {
  // entries: [{ label, value }] sorted descending, already resolved to display names
  if (!Array.isArray(entries) || !entries.length) return null;
  const rows = entries.slice(0, 10).map((r, i) => ({ label: r.label || r.name || `Player ${i+1}`, value: Number(r.value) || Number(r.score) || 0 })).filter(r => r.value > 0);
  const W = 900;
  const rowH = 62;
  const H = 140 + rows.length * rowH;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#111827');
  bg.addColorStop(1, '#1f2937');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 40px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(title || 'Leaderboard', 40, 65);

  const maxVal = Math.max(1, ...rows.map((r) => r.value));
  const barX = 260, barMaxW = W - barX - 140, barH = 34;

  rows.forEach((row, i) => {
    const y = 110 + i * rowH;
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    ctx.fillStyle = '#e5e7eb';
    ctx.font = 'bold 26px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(String(medal), 40, y + barH - 6);

    const nameW = 180;
    ctx.font = '22px sans-serif';
    ctx.fillStyle = '#d1d5db';
    const label = fitText(ctx, row.label, nameW, 22, 14, '400');
    ctx.font = `${label}px sans-serif`;
    ctx.fillText(row.label, 100, y + barH - 8);

    ctx.fillStyle = '#00000055';
    roundRect(ctx, barX, y, barMaxW, barH, 10);
    ctx.fill();
    const w = Math.max(10, (row.value / maxVal) * barMaxW);
    const barGrad = ctx.createLinearGradient(barX, 0, barX + w, 0);
    barGrad.addColorStop(0, '#6366f1');
    barGrad.addColorStop(1, '#a855f7');
    ctx.fillStyle = barGrad;
    roundRect(ctx, barX, y, w, barH, 10);
    ctx.fill();

    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText(String(row.value), W - 40, y + barH - 8);
    ctx.textAlign = 'left';
  });

  return canvas.toBuffer('image/png');
}

/** Monster card — renders a card_game creature as a collectible-style card image. */
async function monsterCard({ name, type, rarity, emoji, hp, atk, def }) {
  const W = 500, H = 700;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const RARITY_COLORS = {
    common: ['#4b5563', '#6b7280'],
    uncommon: ['#065f46', '#10b981'],
    rare: ['#1e3a8a', '#3b82f6'],
    legendary: ['#78350f', '#f59e0b'],
  };
  const [c1, c2] = RARITY_COLORS[rarity] || RARITY_COLORS.common;

  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, c1);
  bg.addColorStop(1, c2);
  ctx.fillStyle = bg;
  roundRect(ctx, 0, 0, W, H, 28);
  ctx.fill();

  ctx.fillStyle = '#00000055';
  roundRect(ctx, 20, 20, W - 40, H - 40, 20);
  ctx.fill();

  // emoji "art" area
  ctx.font = '180px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji || '❔', W / 2, 260);

  ctx.font = 'bold 44px sans-serif';
  ctx.fillStyle = '#ffffff';
  const nameSize = fitText(ctx, name, W - 80, 44, 26);
  ctx.font = `bold ${nameSize}px sans-serif`;
  ctx.fillText(name, W / 2, 420);

  ctx.font = '24px sans-serif';
  ctx.fillStyle = '#ffffffcc';
  ctx.fillText(`${type} • ${(rarity || '').toUpperCase()}`, W / 2, 460);

  // stat pills
  const stats = [['HP', hp], ['ATK', atk], ['DEF', def]];
  const pillW = 130, pillH = 60, gap = 15, totalW = stats.length * pillW + (stats.length - 1) * gap;
  let x = (W - totalW) / 2;
  const y = 540;
  stats.forEach(([label, val]) => {
    ctx.fillStyle = '#ffffff22';
    roundRect(ctx, x, y, pillW, pillH, 12);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 18px sans-serif';
    ctx.fillText(label, x + pillW / 2, y + 22);
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText(String(val), x + pillW / 2, y + 46);
    x += pillW + gap;
  });

  return canvas.toBuffer('image/png');
}

/** Composite profile card — avatar, name, equipped title, level/XP bar, and currency
 *  balance in one image. Combines leveling + economy + shop data. */
async function profileCard({ name, avatarUrl, title, level, xpIntoLevel, xpToNextLevel, balance, currencyName }) {
  const W = 900, H = 420;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#0f172a');
  grad.addColorStop(1, '#1e293b');
  ctx.fillStyle = grad;
  roundRect(ctx, 0, 0, W, H, 24);
  ctx.fill();

  // avatar
  const avSize = 220, avX = 50, avY = 60;
  ctx.save();
  ctx.beginPath();
  ctx.arc(avX + avSize / 2, avY + avSize / 2, avSize / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  const avatar = avatarUrl ? await safeLoadImage(avatarUrl) : null;
  if (avatar) {
    ctx.drawImage(avatar, avX, avY, avSize, avSize);
  } else {
    ctx.fillStyle = '#334155';
    ctx.fillRect(avX, avY, avSize, avSize);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 100px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((name || '?').charAt(0).toUpperCase(), avX + avSize / 2, avY + avSize / 2 + 8);
  }
  ctx.restore();
  ctx.strokeStyle = '#38bdf855';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(avX + avSize / 2, avY + avSize / 2, avSize / 2, 0, Math.PI * 2);
  ctx.stroke();

  const textX = 320;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  if (title) {
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText(title.toUpperCase(), textX, 90);
  }

  ctx.fillStyle = '#ffffff';
  const nameSize = fitText(ctx, name || 'User', W - textX - 40, 48, 26);
  ctx.font = `bold ${nameSize}px sans-serif`;
  ctx.fillText(name || 'User', textX, 140);

  ctx.font = '26px sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(`Level ${level}`, textX, 180);

  // xp bar
  const barX = textX, barY = 210, barW = W - textX - 60, barH = 30;
  ctx.fillStyle = '#00000055';
  roundRect(ctx, barX, barY, barW, barH, 15);
  ctx.fill();
  const total = xpIntoLevel + xpToNextLevel;
  const pct = total > 0 ? Math.min(1, xpIntoLevel / total) : 1;
  const xpGrad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
  xpGrad.addColorStop(0, '#38bdf8');
  xpGrad.addColorStop(1, '#818cf8');
  ctx.fillStyle = xpGrad;
  roundRect(ctx, barX, barY, Math.max(barH, barW * pct), barH, 15);
  ctx.fill();
  ctx.fillStyle = '#cbd5e1';
  ctx.font = '18px sans-serif';
  ctx.fillText(`${xpIntoLevel}/${total} XP`, barX, barY + barH + 26);

  // currency pill
  const pillY = 300, pillH = 70;
  ctx.fillStyle = '#ffffff11';
  roundRect(ctx, textX, pillY, W - textX - 60, pillH, 16);
  ctx.fill();
  ctx.fillStyle = '#facc15';
  ctx.font = 'bold 32px sans-serif';
  ctx.fillText(`💰 ${balance} ${currencyName || ''}`.trim(), textX + 20, pillY + 45);

  return canvas.toBuffer('image/png');
}

/** Battle result card — two creature cards side by side with HP bars showing damage taken,
 *  and a winner banner. Takes cardGame.battle()'s `visual` field directly. */
async function battleCard({ challengerName, opponentName, visual, winner }) {
  const W = 900, H = 500;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#18181b';
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 50px sans-serif';
  ctx.fillStyle = '#f4f4f5';
  ctx.fillText('⚔️', W / 2, 60);

  async function drawSide(side, cx, label, won) {
    const { card, maxHp, finalHp } = side;
    ctx.font = '110px sans-serif';
    ctx.fillText(card.emoji || '❔', cx, 180);

    ctx.font = 'bold 30px sans-serif';
    ctx.fillStyle = won ? '#4ade80' : '#f4f4f5';
    ctx.fillText(card.name, cx, 260);

    ctx.font = '18px sans-serif';
    ctx.fillStyle = '#a1a1aa';
    ctx.fillText(`${label} • ${card.type}`, cx, 290);

    // HP bar
    const barW = 260, barH = 26, barX = cx - barW / 2, barY = 320;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#3f3f46';
    roundRect(ctx, barX, barY, barW, barH, 13);
    ctx.fill();
    const pct = maxHp > 0 ? finalHp / maxHp : 0;
    ctx.fillStyle = pct > 0.5 ? '#22c55e' : pct > 0.2 ? '#eab308' : '#ef4444';
    roundRect(ctx, barX, barY, Math.max(pct > 0 ? 10 : 0, barW * pct), barH, 13);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText(`${finalHp} / ${maxHp} HP`, cx, barY + barH + 24);

    if (won) {
      ctx.font = 'bold 22px sans-serif';
      ctx.fillStyle = '#4ade80';
      ctx.fillText('🏆 WINNER', cx, barY + barH + 60);
    }
  }

  if (!visual || !visual.challenger || !visual.opponent) return null;
  await drawSide(visual.challenger, W * 0.27, challengerName, winner === 'challenger');
  await drawSide(visual.opponent, W * 0.73, opponentName, winner === 'opponent');

  ctx.font = 'bold 60px sans-serif';
  ctx.fillStyle = '#71717a';
  ctx.fillText('VS', W / 2, 200);

  return canvas.toBuffer('image/png');
}


/**
 * Tweet-style card (X/Twitter lookalike) for funny posts / debate prompts.
 */
async function tweetCard({ handle, name, text, likes, theme = 'dark' }) {
  const W = 900;
  const pad = 36;
  const avatar = 64;
  // measure wrapped text height
  const canvas0 = createCanvas(W, 200);
  const ctx0 = canvas0.getContext('2d');
  ctx0.font = '32px sans-serif';
  const maxTextW = W - pad * 2;
  const words = String(text || '').replace(/\n/g, ' \n ').split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (w === '\n') { lines.push(line); line = ''; continue; }
    const test = line ? line + ' ' + w : w;
    if (ctx0.measureText(test).width > maxTextW && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  const lineH = 42;
  const textBlock = Math.max(lines.length, 1) * lineH;
  const H = pad + avatar + 20 + textBlock + 56 + pad;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // background
  if (theme === 'light') {
    ctx.fillStyle = '#ffffff';
  } else {
    ctx.fillStyle = '#000000';
  }
  roundRect(ctx, 0, 0, W, H, 28);
  ctx.fill();

  // subtle border
  ctx.strokeStyle = theme === 'light' ? '#eff3f4' : '#2f3336';
  ctx.lineWidth = 2;
  roundRect(ctx, 1, 1, W - 2, H - 2, 28);
  ctx.stroke();

  // avatar circle
  const ax = pad, ay = pad;
  const grad = ctx.createLinearGradient(ax, ay, ax + avatar, ay + avatar);
  grad.addColorStop(0, '#1d9bf0');
  grad.addColorStop(1, '#7856ff');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(ax + avatar / 2, ay + avatar / 2, avatar / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const initial = String(name || handle || 'B').charAt(0).toUpperCase();
  ctx.fillText(initial, ax + avatar / 2, ay + avatar / 2 + 1);

  // name + handle
  const tx = ax + avatar + 16;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = theme === 'light' ? '#0f1419' : '#e7e9ea';
  ctx.font = 'bold 28px sans-serif';
  ctx.fillText(String(name || 'Broken').slice(0, 28), tx, ay + 28);
  ctx.fillStyle = theme === 'light' ? '#536471' : '#71767b';
  ctx.font = '24px sans-serif';
  ctx.fillText('@' + String(handle || 'broken').replace(/^@/, '').slice(0, 24), tx, ay + 58);

  // verified badge
  ctx.fillStyle = '#1d9bf0';
  const nx = tx + ctx.measureText(String(name || 'Broken').slice(0, 28)).width + 10;
  // measure name width with bold font
  ctx.font = 'bold 28px sans-serif';
  const nameW = ctx.measureText(String(name || 'Broken').slice(0, 28)).width;
  const bx = tx + nameW + 12;
  ctx.beginPath();
  ctx.arc(bx, ay + 20, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('✓', bx, ay + 25);

  // body text
  ctx.textAlign = 'left';
  ctx.fillStyle = theme === 'light' ? '#0f1419' : '#e7e9ea';
  ctx.font = '32px sans-serif';
  let y = ay + avatar + 28;
  for (const ln of lines) {
    ctx.fillText(ln, pad, y);
    y += lineH;
  }

  // footer metrics
  y = H - pad - 8;
  const likesN = likes != null ? likes : (Math.floor(Math.random() * 8000) + 120);
  const rts = Math.floor(likesN * 0.35);
  ctx.fillStyle = theme === 'light' ? '#536471' : '#71767b';
  ctx.font = '22px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`♡  ${likesN.toLocaleString()}    ↻  ${rts.toLocaleString()}    💬  ${Math.floor(rts * 0.4)}`, pad, y);

  // X logo corner
  ctx.fillStyle = theme === 'light' ? '#0f1419' : '#e7e9ea';
  ctx.font = 'bold 26px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('𝕏', W - pad, pad + 28);

  return canvas.toBuffer('image/png');
}


/** Support / donate card with bank details. */
async function donateCard({ name, bank, account, subtitle }) {
  const W = 900, H = 520;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#0f2027');
  grad.addColorStop(0.5, '#203a43');
  grad.addColorStop(1, '#2c5364');
  ctx.fillStyle = grad;
  roundRect(ctx, 0, 0, W, H, 28);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  roundRect(ctx, 40, 40, W - 80, H - 80, 20);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 42px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('🙏 Support the Project', W / 2, 110);

  ctx.font = '28px sans-serif';
  ctx.fillStyle = '#a8dadc';
  ctx.fillText(String(subtitle || 'Thank you for your kindness'), W / 2, 160);

  const rows = [
    ['👤 Name', String(name || '')],
    ['🏦 Bank', String(bank || '')],
    ['💳 Account', String(account || '')],
  ];
  let y = 230;
  ctx.textAlign = 'left';
  for (const [label, value] of rows) {
    ctx.fillStyle = '#90e0ef';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText(label, 100, y);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 32px sans-serif';
    ctx.fillText(value, 100, y + 42);
    y += 95;
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = '#caf0f8';
  ctx.font = '22px sans-serif';
  ctx.fillText('Every support keeps the bots running ❤️', W / 2, H - 50);

  return canvas.toBuffer('image/png');
}

module.exports = { donateCard, rankCard, welcomeCard, quoteCard, shipCard, leaderboardCard, monsterCard, profileCard, battleCard, tweetCard };

