'use strict';

const groupControl = require('./groupControl');
const ownerCommands = require('./ownerCommands');
const commandPrefix = require('./commandPrefix');

function isExplicitCommand(text) {
  return groupControl.isGroupPluginCommand(text) || ownerCommands.isOwnerPluginCommand(text);
}

async function route(ctx, text) {
  const owner = await ownerCommands.route(ctx, text);
  if (owner.handled) return owner;
  return groupControl.route(ctx, text);
}

async function handleMedia(ctx, text, imageBuffer) {
  return ownerCommands.handleMedia(ctx, text, imageBuffer);
}

module.exports = {
  route,
  handleMedia,
  isExplicitCommand,
  parseCommand: commandPrefix.parseCommand,
  getPrefix: commandPrefix.getPrefix,
  isSetProfilePictureCommand: ownerCommands.isSetProfilePictureCommand,
};
