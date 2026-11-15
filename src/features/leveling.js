// features/leveling.js — earn XP for chatting, level up, per-user leaderboard.
// Deterministic, no AI involved — a fixed XP amount per message with a short cooldown so
// spamming doesn't inflate levels, and a simple increasing curve for how much each level costs.
const { Collection } = require('../db');
const config = require('../config');
const achievements = require('./achievements');

const xpStore = new Collection('leveling_xp', {}); // userId -> { xp, level, lastGainAt }
const XP_PER_MESSAGE = config.leveling?.xpPerMessage ?? 15;
const XP_COOLDOWN_MS = (config.leveling?.cooldownSeconds ?? 45) * 1000;
const settingsStore = new Collection('leveling_settings', { enabled: false });
function isEnabled() { return false; /* agent mode: leveling hard-off */ }
function setEnabled(enabled) { settingsStore.set('enabled', !!enabled); return !!enabled; }

/** XP required to reach a given level (cumulative), roughly quadratic so it slows down. */
function xpForLevel(level) {
  return Math.round(50 * Math.pow(level, 1.6));
}

function levelForXp(xp) {
  let level = 0;
  while (xpForLevel(level + 1) <= xp) level++;
  return level;
}

function get(userId) {
  return xpStore.get(userId, { xp: 0, level: 0, lastGainAt: 0 });
}

/**
 * Call on every message from a user. Returns { gained, leveledUp, newLevel } — gained is 0
 * if still on cooldown (no XP awarded, but nothing breaks).
 */
function onMessage(userId) {
  if (!isEnabled()) return { gained: 0, leveledUp: false, newLevel: get(userId).level, disabled: true };
  const rec = get(userId);
  const now = Date.now();
  if (now - rec.lastGainAt < XP_COOLDOWN_MS) {
    return { gained: 0, leveledUp: false, newLevel: rec.level };
  }
  const prevLevel = rec.level;
  rec.xp += XP_PER_MESSAGE;
  rec.level = levelForXp(rec.xp);
  rec.lastGainAt = now;
  xpStore.set(userId, rec);
  const leveledUp = rec.level > prevLevel;
  let achievement = null;
  if (leveledUp && rec.level >= 25) {
    achievement = achievements.unlock(userId, 'level_25');
  } else if (leveledUp && rec.level >= 10) {
    achievement = achievements.unlock(userId, 'level_10');
  }
  return { gained: XP_PER_MESSAGE, leveledUp, newLevel: rec.level, achievement };
}

function profile(userId) {
  const rec = get(userId);
  const currentLevelXp = xpForLevel(rec.level);
  const nextLevelXp = xpForLevel(rec.level + 1);
  return {
    xp: rec.xp,
    level: rec.level,
    xpIntoLevel: rec.xp - currentLevelXp,
    xpToNextLevel: nextLevelXp - rec.xp,
  };
}

function leaderboard(limit = 10) {
  const all = xpStore.all();
  return Object.entries(all)
    .sort((a, b) => b[1].xp - a[1].xp)
    .slice(0, limit)
    .map(([userId, rec]) => ({ userId, xp: rec.xp, level: rec.level }));
}

module.exports = { onMessage, profile, leaderboard, xpForLevel, isEnabled, setEnabled };
