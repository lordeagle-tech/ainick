'use strict';

const commandPrefix = require('./commandPrefix');

// Song downloads are implemented by the existing community play route.
// This plugin exposes that canonical command in the plugin catalog and keeps
// bare `play` from falling through to an unrelated AI response.
const menuCommands = ['play'];

function commandText(input) {
  return commandPrefix.parseCommand(input).text.trim();
}

function isCommand(input) {
  return /^play(?:\s|$)/i.test(commandText(input));
}

async function route(_ctx, input) {
  const text = commandText(input);
  if (!/^play$/i.test(text)) return { handled: false };
  return { handled: true, text: 'Usage: `play <song title or artist>`.' };
}

module.exports = { isCommand, route, menuCommands };
