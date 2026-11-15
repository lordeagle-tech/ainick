// features/scheduledLeaderboard.js — admin opts a group into an automatic leaderboard post
// (daily or weekly), rendered as the same canvas bar-chart image as canvas_leaderboard_card.
// Same interval-scheduler pattern as reminders.js/birthdays.js.
const { Collection } = require('../db');
const logger = require('../logger');

const store = new Collection('scheduled_leaderboard', {}); // chatId -> { enabled, kind, frequency, lastPostedKey }

const DEFAULTS = { enabled: false, kind: 'level', frequency: 'weekly' }; // frequency: 'daily' | 'weekly'

function getSettings(chatId) {
  return { ...DEFAULTS, ...store.get(chatId, {}) };
}

function updateSettings(chatId, patch) {
  return store.update(chatId, (cur = {}) => ({ ...DEFAULTS, ...cur, ...patch }));
}

/** A key that changes once per day (daily) or once per ISO week (weekly), so we can tell
 *  "have I already posted for this period" without a precise cron. */
function periodKey(frequency, date) {
  if (frequency === 'daily') {
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  }
  // ISO week number
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${week}`;
}

const CHECK_MS = 60 * 60 * 1000; // hourly is plenty for daily/weekly posts
let timer = null;

/** postFn(chatId, kind) is provided by the caller (index.js) so this module doesn't need
 *  to know how to render a canvas card or reach the socket directly. */
function startScheduler(postFn) {
  if (timer) return;
  timer = setInterval(async () => {
    const now = new Date();
    const all = store.all();
    for (const [chatId, rec] of Object.entries(all)) {
      const settings = { ...DEFAULTS, ...rec };
      if (!settings.enabled) continue;
      const key = periodKey(settings.frequency, now);
      if (rec.lastPostedKey === key) continue;
      try {
        await postFn(chatId, settings.kind);
        store.set(chatId, { ...rec, lastPostedKey: key });
      } catch (e) {
        logger.warn({ err: e.message, chatId }, 'scheduledLeaderboard: post failed');
      }
    }
  }, CHECK_MS);
}

module.exports = { getSettings, updateSettings, startScheduler };
