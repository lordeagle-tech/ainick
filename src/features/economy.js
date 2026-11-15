// features/economy.js — a simple virtual-currency economy system.
const { Collection } = require('../db');
const config = require('../config');
const { fmtCurrency, timeAgo } = require('../utils/helpers');
const achievements = require('./achievements');

const wallets = new Collection('economy_wallets', {});
const bank = new Collection('economy_bank', {});
const cooldowns = new Collection('economy_cooldowns', {});

const CUR = config.economy.currencyName;

function normalizeId(userId) {
  // Always store by phone digits only so LID / device / @s.whatsapp.net share one wallet
  const raw = String(userId || '');
  const digits = raw.replace(/\D/g, '');
  // Prefer full international-ish number; if LID-looking short noise, still use digits
  return digits || raw.split('@')[0].split(':')[0] || raw;
}

function getBalance(userId) {
  return wallets.get(normalizeId(userId), 0);
}

function addBalance(userId, amount) {
  const id = normalizeId(userId);
  const bal = wallets.update(id, (b) => (b || 0) + amount, 0);
  if (bal >= 5000) achievements.unlock(id, 'rich_5000');
  return bal;
}

function setBalance(userId, amount) {
  return wallets.set(normalizeId(userId), amount);
}

/** Wallet + bank = total wealth shown on profile/balance. */
function getTotalBalance(userId) {
  const id = normalizeId(userId);
  return getBalance(id) + getBankBalance(id);
}

function getFullAccount(userId) {
  const id = normalizeId(userId);
  return {
    id,
    wallet: getBalance(id),
    bank: getBankBalance(id),
    total: getBalance(id) + getBankBalance(id),
  };
}

function transfer(fromId, toId, amount) {
  if (amount <= 0) throw new Error('Amount must be positive.');
  const bal = getBalance(fromId);
  if (bal < amount) throw new Error(`Not enough ${CUR}. Balance: ${fmtCurrency(bal, CUR)}.`);
  addBalance(fromId, -amount);
  addBalance(toId, amount);
  return { from: getBalance(fromId), to: getBalance(toId) };
}

function _cooldownKey(userId, kind) {
  return `${userId}:${kind}`;
}

function claimDaily(userId) {
  const key = _cooldownKey(userId, 'daily');
  const last = cooldowns.get(key, 0);
  const cooldownMs = config.economy.dailyCooldownHours * 3600 * 1000;
  const remaining = last + cooldownMs - Date.now();
  if (remaining > 0) {
    return { ok: false, message: `You already claimed your daily. Try again in ${timeAgo(remaining)}.` };
  }
  cooldowns.set(key, Date.now());
  const amount = config.economy.dailyAmount;
  const bal = addBalance(userId, amount);
  return { ok: true, message: `You claimed your daily ${fmtCurrency(amount, CUR)}. New balance: ${fmtCurrency(bal, CUR)}.`, amount, balance: bal };
}

function work(userId) {
  const key = _cooldownKey(userId, 'work');
  const last = cooldowns.get(key, 0);
  const cooldownMs = config.economy.workCooldownMin * 60 * 1000;
  const remaining = last + cooldownMs - Date.now();
  if (remaining > 0) {
    return { ok: false, message: `You're tired. Rest for ${timeAgo(remaining)} before working again.` };
  }
  cooldowns.set(key, Date.now());
  const { workMin, workMax } = config.economy;
  const amount = Math.floor(Math.random() * (workMax - workMin + 1)) + workMin;
  const bal = addBalance(userId, amount);
  return { ok: true, message: `You worked and earned ${fmtCurrency(amount, CUR)}. New balance: ${fmtCurrency(bal, CUR)}.`, amount, balance: bal };
}

function leaderboard(limit = 10) {
  const all = wallets.all();
  return Object.entries(all)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([userId, balance]) => ({ userId, balance }));
}

function getBankBalance(userId) {
  return bank.get(userId, 0);
}

/** Move money wallet -> bank. Banked money is untouchable by economy_rob. */
function deposit(userId, amount) {
  amount = Math.floor(amount);
  if (amount <= 0) return { ok: false, error: 'Amount must be positive.' };
  const walletBal = getBalance(userId);
  if (walletBal < amount) return { ok: false, error: `Not enough in your wallet. You have ${fmtCurrency(walletBal, CUR)}.` };
  addBalance(userId, -amount);
  const newBank = bank.update(userId, (b) => (b || 0) + amount, 0);
  const unlocked = achievements.unlock(userId, 'banker');
  return { ok: true, deposited: amount, wallet: getBalance(userId), bank: newBank, achievement: unlocked };
}

/** Move money bank -> wallet (makes it robbable again, same trade-off as a real bank run). */
function withdraw(userId, amount) {
  amount = Math.floor(amount);
  if (amount <= 0) return { ok: false, error: 'Amount must be positive.' };
  const bankBal = getBankBalance(userId);
  if (bankBal < amount) return { ok: false, error: `Not enough in your bank. You have ${fmtCurrency(bankBal, CUR)}.` };
  bank.update(userId, (b) => (b || 0) - amount, 0);
  const newWallet = addBalance(userId, amount);
  return { ok: true, withdrawn: amount, wallet: newWallet, bank: getBankBalance(userId) };
}

/**
 * Rob another user's WALLET balance only — banked money (see deposit/withdraw) is always
 * safe. Success chance + a minimum victim balance so it can't be used to grief someone
 * sitting at 0, a shared cooldown so it can't be spammed, and a penalty on failure so it's
 * a real risk/reward mechanic rather than free money.
 */
function rob(fromId, toId) {
  if (fromId === toId) return { ok: false, message: "You can't rob yourself." };
  const key = _cooldownKey(fromId, 'rob');
  const last = cooldowns.get(key, 0);
  const cooldownMs = (config.economy.robCooldownMin || 30) * 60 * 1000;
  const remaining = last + cooldownMs - Date.now();
  if (remaining > 0) {
    return { ok: false, message: `Lay low — try robbing again in ${timeAgo(remaining)}.` };
  }
  const victimBal = getBalance(toId);
  const minTarget = config.economy.robMinVictimBalance ?? 50;
  if (victimBal < minTarget) {
    return { ok: false, message: `Not worth robbing — they only have ${fmtCurrency(victimBal, CUR)}.` };
  }
  cooldowns.set(key, Date.now());
  const successChance = config.economy.robSuccessChance ?? 0.45;
  const success = Math.random() < successChance;
  if (success) {
    const pct = config.economy.robMaxPercent ?? 0.25;
    const amount = Math.max(1, Math.floor(victimBal * pct * (0.5 + Math.random() * 0.5)));
    addBalance(toId, -amount);
    addBalance(fromId, amount);
    return { ok: true, success: true, amount, message: `You robbed ${fmtCurrency(amount, CUR)}! New balance: ${fmtCurrency(getBalance(fromId), CUR)}.` };
  } else {
    const finePct = config.economy.robFailFinePercent ?? 0.15;
    const robberBal = getBalance(fromId);
    const fine = Math.max(1, Math.floor(robberBal * finePct));
    addBalance(fromId, -fine);
    return { ok: true, success: false, fine, message: `Caught! You paid a ${fmtCurrency(fine, CUR)} fine. New balance: ${fmtCurrency(getBalance(fromId), CUR)}.` };
  }
}

module.exports = { normalizeId, getTotalBalance, getFullAccount,  getBalance, addBalance, setBalance, transfer, claimDaily, work, rob, leaderboard, getBankBalance, deposit, withdraw, CUR };
