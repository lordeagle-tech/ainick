'use strict';

function commandCard(title, message, icon = 'ℹ️') {
  const lines = Array.isArray(message) ? message : String(message || '').split(/\r?\n/);
  return [
    `╭─〘 ${icon} *${title}* 〙`,
    '┃ ',
    ...lines.map((line) => `┃❍ ${String(line)}`),
    '┃ ',
    '╰──────────⊷',
  ].join('\n');
}

function commandResponse(message) {
  if (message === null || message === undefined) return message;
  const text = String(message);
  if (!text.trim() || text.trimStart().startsWith('╭─〘')) return text;
  return commandCard('𝐍𝐈𝐂𝐊 𝐀𝐈', text, '🤖');
}

function accessDenied(scope = 'owner') {
  const audience = String(scope).toLowerCase();
  const notice = audience === 'owner'
    ? '🔒 This section is for the *owner only.*'
    : audience === 'group admin'
      ? '🔒 This section is for *group admins only.*'
      : '🔒 This section is for *admins only.*';
  return [
    '╭─〘 🔒 *𝐀𝐂𝐂𝐄𝐒𝐒 𝐃𝐄𝐍𝐈𝐄𝐃* 〙',
    '┃ ',
    `┃❍ ${notice}`,
    '┃ ',
    '╰──────────⊷',
  ].join('\n');
}

module.exports = { commandCard, commandResponse, accessDenied };
