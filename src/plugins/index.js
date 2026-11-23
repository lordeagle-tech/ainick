'use strict';

const groupControl = require('./groupControl');
const groupCommands = require('./groupCommands');
const ownerCommands = require('./ownerCommands');
const commandPrefix = require('./commandPrefix');
const keithApis = require('./keithApis');
const checkerTools = require('./checkerTools');
const serverTools = require('./serverTools');
const musicCommands = require('./musicCommands');
const stickerCommands = require('./stickerCommands');
const githubCommands = require('./githubCommands');
const networkCommands = require('./networkCommands');
const fileCommands = require('./fileCommands');
const ownerDiagnostics = require('./ownerDiagnostics');
const getPlugin = require('./getPlugin');
const qualityOfLife = require('./qualityOfLife');

function isExplicitCommand(text) {
  const command = commandPrefix.parseCommand(text).text.trim();
  const normalized = command.toLowerCase();
  const listedCommand = getMenuSections().some(({ commands }) =>
    commands.some((name) => {
      const candidate = String(name || '').trim().toLowerCase();
      return candidate && (normalized === candidate || normalized.startsWith(`${candidate} `));
    })
  );
  return listedCommand
    || /^normal\s+menu$/i.test(command)
    || checkerTools.isCommand(text)
    || serverTools.isCommand(text)
    || musicCommands.isCommand(text)
    || githubCommands.isCommand(text)
    || networkCommands.isCommand(text)
    || keithApis.isCommand(text)
    || fileCommands.isCommand(text)
    || getPlugin.isCommand(text)
    || qualityOfLife.isCommand(text)
    || ownerDiagnostics.isCommand(text)
    || groupControl.isGroupPluginCommand(text)
    || groupCommands.isCommand(text)
    || ownerCommands.isOwnerPluginCommand(text);
}

async function route(ctx, text) {
  const checker = await checkerTools.route(ctx, text);
  if (checker.handled) return checker;
  const server = await serverTools.route(ctx, text);
  if (server.handled) return server;
  const music = await musicCommands.route(ctx, text);
  if (music.handled) return music;
  const sticker = await stickerCommands.route(ctx, text);
  if (sticker.handled) return sticker;
  const github = await githubCommands.route(ctx, text);
  if (github.handled) return github;
  const network = await networkCommands.route(ctx, text);
  if (network.handled) return network;
  const keith = await keithApis.route(ctx, text);
  if (keith.handled) return keith;
  const files = await fileCommands.route(ctx, text);
  if (files.handled) return files;
  const pluginFile = await getPlugin.route(ctx, text);
  if (pluginFile.handled) return pluginFile;
  const diagnostics = await ownerDiagnostics.route(ctx, text);
  if (diagnostics.handled) return diagnostics;
  const extras = await qualityOfLife.route(ctx, text);
  if (extras.handled) return extras;
  const groups = await groupCommands.route(ctx, text);
  if (groups.handled) return groups;
  const owner = await ownerCommands.route(ctx, text);
  if (owner.handled) return owner;
  return groupControl.route(ctx, text);
}

async function handleMedia(ctx, text, imageBuffer, videoBuffer) {
  const sticker = await stickerCommands.handleMedia(ctx, text, imageBuffer, videoBuffer);
  if (sticker.handled) return sticker;
  const checker = await checkerTools.handleMedia(ctx, text, imageBuffer);
  if (checker.handled) return checker;
  const groups = await groupCommands.handleMedia(ctx, text, imageBuffer);
  if (groups.handled) return groups;
  const owner = await ownerCommands.handleMedia(ctx, text, imageBuffer);
  if (owner.handled) return owner;
  const extras = await qualityOfLife.handleMedia(ctx, text, imageBuffer);
  if (extras.handled) return extras;
  return groupControl.handleMedia(ctx, text, imageBuffer);
}

function getMenuSections() {
  return [
    { title: '𝐂𝐇𝐄𝐂𝐊𝐄𝐑 𝐓𝐎𝐎𝐋𝐒', commands: checkerTools.menuCommands },
    { title: '𝐒𝐄𝐑𝐕𝐄𝐑 𝐈𝐍𝐅𝐎', commands: serverTools.menuCommands },
    { title: '𝐌𝐔𝐒𝐈𝐂 & 𝐌𝐄𝐃𝐈𝐀', commands: [...musicCommands.menuCommands, ...stickerCommands.menuCommands] },
    { title: '𝐆𝐈𝐓𝐇𝐔𝐁', commands: githubCommands.menuCommands },
    { title: '𝐂𝐋𝐎𝐍𝐄 (PUBLIC)', commands: githubCommands.publicMenuCommands },
    { title: '𝐍𝐄𝐓𝐖𝐎𝐑𝐊 (PUBLIC)', commands: networkCommands.publicMenuCommands },
    { title: 'API Commands', commands: keithApis.menuCommands },
    { title: '𝐄𝐗𝐓𝐑𝐀𝐒', commands: qualityOfLife.menuCommands },
    { title: '𝐆𝐑𝐎𝐔𝐏 𝐂𝐎𝐌𝐌𝐀𝐍𝐃𝐒', commands: [...groupControl.menuCommands, ...groupCommands.menuCommands] },
    { title: 'Owner Only', commands: [...ownerCommands.menuCommands, ...fileCommands.menuCommands, ...getPlugin.menuCommands, ...ownerDiagnostics.menuCommands, ...networkCommands.ownerMenuCommands] },
  ].map(({ title, commands }) => ({
    title,
    commands: [...new Set((commands || []).map((name) => String(name).trim()).filter(Boolean))],
  })).filter((section) => section.commands.length);
}

module.exports = {
  route,
  handleMedia,
  isExplicitCommand,
  getMenuSections,
  parseCommand: commandPrefix.parseCommand,
  getPrefix: commandPrefix.getPrefix,
  isSetProfilePictureCommand: ownerCommands.isSetProfilePictureCommand,
  isStickerBattleEnabled: qualityOfLife.isStickerBattleEnabled,
  isDeferredMediaCommand(text) {
    return checkerTools.isNsfwCommand(text)
      || ownerCommands.isSetProfilePictureCommand(text)
      || groupCommands.isGroupPictureCommand(text)
      || groupControl.isGroupPictureCommand(text);
  },
};
