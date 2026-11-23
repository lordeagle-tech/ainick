'use strict';

const commandPrefix = require('./commandPrefix');
const zynexPlay = require('../features/zynexPlay');

// The song downloader is ported from the zynextelee project's play command.
// It drives `play <song>` and the `add play <song>` alias.
const menuCommands = ['play', 'add play'];

function commandText(input) {
  return commandPrefix.parseCommand(input).text.trim();
}

function isCommand(input) {
  return /^(?:add\s+)?play(?:\s|$)/i.test(commandText(input));
}

function fileNameFor(title, ext) {
  const base = String(title || 'audio').replace(/[/\\?%*:|"<>]/g, '_').slice(0, 100) || 'audio';
  return `${base}.${ext === 'm4a' ? 'm4a' : 'mp3'}`;
}

function sanitize(value, limit = 180) {
  return String(value || '').replace(/[\r\n`*_~]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

async function play(ctx, query) {
  const result = await zynexPlay.downloadSong(query);
  if (!result.ok) return { handled: true, text: `❌ Could not play *${sanitize(query)}*\n${sanitize(result.error, 300)}` };

  const title = sanitize(result.title, 140);
  const mime = result.ext === 'm4a' ? 'audio/mp4' : 'audio/mpeg';
  const payload = result.payload;
  const fileName = fileNameFor(result.title, result.ext);

  try {
    await ctx.sock.sendMessage(ctx.chatId, {
      audio: payload,
      mimetype: mime,
      ptt: false,
      contextInfo: {
        externalAdReply: {
          title,
          body: '🎵 Nick AI · Zynex play',
          sourceUrl: result.youtubeUrl || undefined,
          renderLargerThumbnail: false,
          mediaType: 1,
        },
      },
    });
    await ctx.sock.sendMessage(ctx.chatId, {
      document: payload,
      mimetype: mime,
      fileName,
    });
    return { handled: true, text: null };
  } catch (e) {
    return { handled: true, text: `❌ Could not send the audio: ${sanitize(e.message, 300)}` };
  }
}

async function route(ctx, input) {
  const parsed = commandPrefix.parseCommand(input);
  const text = parsed.text.trim();
  if (!isCommand(input)) return { handled: false };
  if (commandPrefix.needsPrefix(parsed)) {
    return { handled: true, text: `This command needs the configured prefix. Try: \`${parsed.prefix}${text}\`` };
  }

  const match = text.match(/^(?:add\s+)?play\s+([\s\S]+)$/i);
  if (!match) return { handled: true, text: 'Usage: `play <song title or YouTube link>` (or `add play <song>`).' };
  if (!ctx?.sock || !ctx?.chatId) {
    return { handled: true, text: 'Playback is unavailable in this context.' };
  }
  return play(ctx, match[1].trim());
}

module.exports = { isCommand, route, menuCommands };
