const fs = require('fs');
const path = require('path');
const pino = require('pino');
const config = require('./config');

// Previously this only wrote to stdout — fine for Pterodactyl's live console,
// but nothing was ever persisted to disk, so there was no actual log FILE to
// read, grep, or tail after the fact (the agent burned several tool calls
// hunting for one that doesn't exist). Now every line goes to both: stdout
// (unchanged — console output looks identical) and logs/bot.log on disk.
const LOG_DIR = path.join(process.cwd(), 'logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
const LOG_FILE = path.join(LOG_DIR, 'bot.log');

let fileStream;
try {
  fileStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
} catch (e) {
  // If the filesystem is somehow unwritable, fall back to stdout-only rather
  // than crashing the bot over logging.
  fileStream = null;
}

const streams = [{ stream: process.stdout }];
if (fileStream) streams.push({ stream: fileStream });

const logger = pino({ level: config.logLevel }, pino.multistream(streams));

module.exports = logger;
module.exports.LOG_FILE = LOG_FILE;
module.exports.LOG_DIR = LOG_DIR;
