'use strict';

const commandPrefix = require('./commandPrefix');
const stickers = require('../features').stickers;
const logger = require('../logger');

const menuCommands = ['sticker', 's'];
const usageText = 'Send or reply to an image or video with `sticker` (or `s`) to convert it.';

async function route(ctx, input) {
  const parsed = commandPrefix.parseCommand(input);
  if (!/^(?:sticker|s)$/i.test(parsed.text.trim())) return { handled: false };
  if (commandPrefix.needsPrefix(parsed)) {
    return { handled: true, text: `Use your command prefix: \`${parsed.prefix}sticker\` or \`${parsed.prefix}s\`.` };
  }
  if (['imageMessage', 'videoMessage'].includes(ctx.messageMeta?.quotedMediaType)) {
    return { handled: false };
  }
  return { handled: true, text: usageText };
}

async function handleMedia(_ctx, input, imageBuffer, videoBuffer) {
  const parsed = commandPrefix.parseCommand(input);
  const command = parsed.text.trim();
  if (!/^(?:sticker|s)$/i.test(command)) return { handled: false };
  if (commandPrefix.needsPrefix(parsed)) {
    return { handled: true, text: `Use your command prefix: \`${parsed.prefix}sticker\` or \`${parsed.prefix}s\`.` };
  }
  if (!imageBuffer && !videoBuffer) {
    return { handled: true, text: usageText };
  }

  if (imageBuffer) {
    const stickerBuffer = await stickers.bufferToSticker(imageBuffer);
    return stickerBuffer
      ? { handled: true, stickerBuffer }
      : { handled: true, text: 'I could not read that image. Try a different image format.' };
  }

  try {
    return { handled: true, stickerBuffer: await stickers.videoBufferToSticker(videoBuffer) };
  } catch (e) {
    logger.warn({ err: e.message }, 'video sticker conversion failed');
    return {
      handled: true,
      text: e.code === 'STICKER_TOO_LARGE'
        ? e.message
        : 'I could not convert that video. Try a supported video file and make sure FFmpeg is available.',
    };
  }
}

module.exports = { route, handleMedia, menuCommands };
