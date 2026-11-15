// features/daemons.js — toggle daemon mode (respond/ignore) and group mode
const { Collection } = require('../db');
const logger = require('../logger');

// Fixed: the original called db.get/db.set which don't exist on db.js (it only
// exports Collection). Persist via a proper Collection keyed under a fixed key.
const store = new Collection('system_daemons', {});

function getSettings() {
  return store.get('settings', {
    daemonMode: true,  // respond to messages
    groupMode: true,   // respond in groups
  });
}

function setSettings(settings) {
  store.set('settings', settings);
  logger.info({ settings }, 'Daemon settings updated');
  return settings;
}

function toggleDaemon(enable) {
  const settings = getSettings();
  settings.daemonMode = enable;
  return setSettings(settings).daemonMode;
}

function toggleGroup(enable) {
  const settings = getSettings();
  settings.groupMode = enable;
  return setSettings(settings).groupMode;
}

function isDaemonActive() {
  return getSettings().daemonMode;
}

function isGroupModeActive() {
  return getSettings().groupMode;
}

module.exports = {
  getSettings,
  setSettings,
  toggleDaemon,
  toggleGroup,
  isDaemonActive,
  isGroupModeActive,
};
