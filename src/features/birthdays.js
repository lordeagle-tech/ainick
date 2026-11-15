// features/birthdays.js — set a birthday (month/day only, no year needed), get an automatic
// shoutout in the chat where it was set when the day comes around. Same scheduler pattern as
// reminders.js: a persisted store + a background interval that checks once a day.
const { Collection } = require('../db');
const { numFromJid } = require('../utils/helpers');
const logger = require('../logger');

const store = new Collection('birthdays', {}); // userId -> { month, day, chatId, lastAnnouncedYear }

function setBirthday(userId, chatId, month, day) {
  userId = numFromJid(userId);
  month = Number(month);
  day = Number(day);
  if (!(month >= 1 && month <= 12)) return { ok: false, error: 'Month must be 1-12.' };
  const daysInMonth = new Date(2024, month, 0).getDate(); // 2024 = leap year, so Feb 29 is valid to set
  if (!(day >= 1 && day <= daysInMonth)) return { ok: false, error: `Day must be 1-${daysInMonth} for that month.` };
  const existing = store.get(userId, {});
  store.set(userId, { ...existing, month, day, chatId });
  return { ok: true, month, day };
}

function getBirthday(userId) {
  const rec = store.get(numFromJid(userId), null);
  if (!rec) return null;
  return { month: rec.month, day: rec.day };
}

function removeBirthday(userId) {
  userId = numFromJid(userId);
  if (!store.get(userId, null)) return { ok: false, error: 'No birthday set.' };
  store.delete(userId);
  return { ok: true };
}

function _all() {
  return store.all();
}

// A single long-lived interval, checked once a day — safe to call again after reconnect.
const CHECK_MS = 6 * 60 * 60 * 1000; // every 6h is plenty for a once-a-day event
let activeSock = null;
let timer = null;

function startScheduler(sock) {
  activeSock = sock;
  if (timer) return;
  timer = setInterval(async () => {
    if (!activeSock) return;
    const now = new Date();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const year = now.getFullYear();
    const all = _all();
    for (const [userId, rec] of Object.entries(all)) {
      if (rec.month !== month || rec.day !== day) continue;
      if (rec.lastAnnouncedYear === year) continue; // already wished them this year
      try {
        await activeSock.sendMessage(rec.chatId, {
          text: `🎂 Happy birthday, @${userId}! 🎉`,
          mentions: [`${userId}@s.whatsapp.net`],
        });
        store.set(userId, { ...rec, lastAnnouncedYear: year });
      } catch (e) {
        logger.warn({ err: e.message, userId }, 'birthdays: failed to send announcement');
      }
    }
  }, CHECK_MS);
}

module.exports = { setBirthday, getBirthday, removeBirthday, startScheduler };
