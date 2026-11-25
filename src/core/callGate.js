'use strict';

/**
 * Pure-ish evaluation of the "did the user call Nick?" gate.
 *
 * The WhatsApp router and the owner `test call` diagnostic must agree exactly,
 * so the decision logic lives here once. No I/O happens inside this function;
 * every dependency is injected by the caller.
 */
function evaluateCallGate({
  mt,
  msg,
  isGroup,
  senderJid,
  actorJid,
  sock,
  preJidMap,
  senderIsElevated,
  botNameList = [],
  selfNums = [],
  jidResolver,
  commandPlugins,
  autoreply,
  config,
  stripBotAddress,
  botNameWordPattern,
  botNamePattern,
  isCoreMenuCommand,
  numFromJid,
}) {
  const rawText = (mt.conversation || mt.extendedTextMessage?.text || mt.imageMessage?.caption || mt.videoMessage?.caption || '').trim();
  const mentions =
    mt.extendedTextMessage?.contextInfo?.mentionedJid ||
    mt.imageMessage?.contextInfo?.mentionedJid ||
    mt.videoMessage?.contextInfo?.mentionedJid ||
    [];
  const msgContextInfo =
    mt.extendedTextMessage?.contextInfo ||
    mt.imageMessage?.contextInfo ||
    mt.videoMessage?.contextInfo ||
    mt.audioMessage?.contextInfo ||
    mt.documentMessage?.contextInfo ||
    mt.stickerMessage?.contextInfo ||
    null;
  const isForwarded = !!(msgContextInfo?.isForwarded || msgContextInfo?.forwardingScore);

  const mentionedBot = (Array.isArray(mentions) ? mentions : [])
    .some((m) => jidResolver.isSelfJid(m, sock));
  const taggedOtherUser = (Array.isArray(mentions) ? mentions : []).some((mentioned) => {
    if (jidResolver.isSelfJid(mentioned, sock)) return false;
    const resolved = jidResolver.resolve(mentioned, preJidMap);
    return !jidResolver.matchesAny(resolved, [
      senderJid,
      actorJid,
      msg?.key?.participantAlt,
      msg?.key?.participantPn,
    ].filter(Boolean));
  });
  const mentionCount = Array.isArray(mentions) ? mentions.length : 0;

  const repliedToBot = (() => {
    try {
      return isGroup
        ? autoreply.isTrackedBotMessageReplied(msg)
        : autoreply.isBotMessageReplied(msg);
    } catch { return false; }
  })();

  const callText = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  // Match Nick as a call. In groups, single-word names (e.g. "nick") are common
  // person names, so only accept them in leading/addressed form; multi-word names
  // (e.g. "nick ai") can match anywhere. In DMs, allow anywhere.
  const namedBot = !!callText
    && botNameList.some((name) => {
      if (!name) return false;
      const ambiguousInGroup = isGroup && !/\s/.test(String(name).trim());
      const pattern = (ambiguousInGroup && botNamePattern) ? botNamePattern(name) : botNameWordPattern(name);
      return pattern.test(callText);
    });
  const cleanText = stripBotAddress(callText, botNameList);
  // Forwarded messages often carry Nick's name in quoted/forwarded content and
  // should not wake the bot in groups unless the user explicitly addressed Nick.
  const forwardedNameWake = namedBot && !(isGroup && isForwarded);

  // A mass-tag broadcast (many @tags, no actual "nick" in the text) must not wake
  // Nick just because his LID happens to be in the recipient list.
  const massTagBroadcast = isGroup && mentionCount >= 5 && !namedBot && !senderIsElevated;
  // In groups, a mention of this account can be an ordinary tag of its human owner.
  // Require an explicit target too before treating a group mention as a Nick call.
  const groupMentionCall = isGroup && mentionedBot && taggedOtherUser
    && (mentionCount <= 3 || namedBot);

  const replyContextInfo = mt.extendedTextMessage?.contextInfo
    || mt.imageMessage?.contextInfo
    || mt.videoMessage?.contextInfo
    || mt.audioMessage?.contextInfo
    || null;
  const quotedPayload = replyContextInfo?.quotedMessage || null;
  const quotedInvestigateCall = !!quotedPayload && /\b(?:investigate|explain|read(?:\s+this)?|check\s+this|look\s+at\s+this|analy[sz]e(?:\s+this)?|verify(?:\s+this)?|is\s+this\s+real|what(?:'s|\s+is)\s+this|what\s+does\s+this\s+(?:say|mean)|tell\s+me\s+about\s+this|details|open\s+this)\b/i
    .test(cleanText || callText || '');

  const parsedCoreText = commandPlugins.parseCommand(cleanText).text;
  const builtInCommand = isCoreMenuCommand(parsedCoreText)
    || /^(?:help|menu|commands|normal menu|(?:\/|!)?(?:up|ping|ping2|uptime|alive|test))$/i.test(cleanText)
    || /^(?:\/|!)?(?:forget\s+me|clear\s+(?:all\s+)?(?:cached\s+)?memory|clear\s+(?:chat|this\s+chat'?s)\s+memory|clear\s+memory\s+(?:all|here)|reset\s+(?:the\s+)?(?:whole\s+|all\s+|bot\s+)?memory|resetmemory|wipe\s+(?:all\s+)?memory)$/i.test(cleanText)
    || /^(?:\/|!)?(?:autostatus(?:\s+view)?(?:\s+(?:on|off|enable|disable|status))?|autotyping(?:\s+(?:on|off|enable|disable|status))?)$/i.test(cleanText)
    || /^(?:\/|!)?(?:help\s+more|test\s+call(?:\s+(?:dm|group))?\b|memory\s+(?:backups?|restore\b)|remember\b|recall(?:\s+all)?|forget\s+fact\b|check\s+link\b|preview\b|digest\b|sticker\s+battle\b|quote(?:\s+of\s+the\s+day)?|roast\b|hype\b)/i.test(cleanText);
  const viewOnceCommand = /^(?:[.!/])?(?:viewonce|view\s*once|reveal|open\s*once|vv)\b/i.test(cleanText || callText || rawText || '');

  const mentionCall = mentionedBot && (!isGroup || groupMentionCall);

  // A sentence that merely starts with a command-like word ("Join hiyo ukick")
  // must not wake Nick. Only count it when it really looks like that command.
  const quotedCallText = String(
    replyContextInfo?.quotedMessage?.conversation
    || replyContextInfo?.quotedMessage?.extendedTextMessage?.text
    || replyContextInfo?.quotedMessage?.ephemeralMessage?.message?.conversation
    || replyContextInfo?.quotedMessage?.imageMessage?.caption
    || replyContextInfo?.quotedMessage?.videoMessage?.caption
    || replyContextInfo?.quotedMessage?.documentMessage?.caption
    || ''
  ).trim();
  const joinLike = /^(?:join|j|joingc)\b/i.test(cleanText);
  const joinPayload = /chat\.whatsapp\.com\/[A-Za-z0-9_-]+/i.test(`${cleanText} ${quotedCallText}`)
    || /^\s*(?:join|j|joingc)\s+[A-Za-z0-9_-]{8,}\s*$/i.test(cleanText);
  const leaveLike = /^(?:left|leave)\b/i.test(cleanText);
  const leaveValid = /^\s*(?:left|leave)(?:\s+confirm)?\s*$/i.test(cleanText);
  const explicitCommandCall = commandPlugins.isExplicitCommand(cleanText)
    && !(joinLike && !joinPayload)
    && !(leaveLike && !leaveValid);

  const explicitCall = mentionCall || forwardedNameWake
    || quotedInvestigateCall
    || commandPlugins.parseCommand(cleanText).hadPrefix
    || builtInCommand
    || viewOnceCommand
    || explicitCommandCall;

  // Sticker battles are an explicit exemption in DMs: replying to one of Nick's
  // stickers with a sticker keeps the exchange alive without needing his name.
  const isAddressed = isGroup
    ? (explicitCall || repliedToBot)
    : (explicitCall || (!!mt.stickerMessage && repliedToBot));
  const isBareCall = !cleanText && (forwardedNameWake || mentionCall);

  // Other bots' messages often tag Nick plus another member, which would otherwise
  // pass the group mention gate and look like a genuine call.
  const senderNum = numFromJid ? numFromJid(senderJid) : String(senderJid || '');
  const knownBot = isGroup && !!rawText && !senderIsElevated
    && (config.behavior?.ignoredBotIds || []).some((id) => String(id) === senderNum || String(id) === String(senderJid));
  const botSignature = isGroup && !!rawText && !senderIsElevated
    && /^✦|ALICIAH AI|^>\s*[^•]{1,60}•\s*(?:AI|BOT)\b|^\[(?:EVILGPT|GPT|AI|BOT)[^\]]{0,20}\]/i.test(rawText);
  const levelNotice = isGroup && !!rawText && rawText.length < 240 && !rawText.includes('?')
    && /(?:reached|hit|is\s+now\s+at)\s+level\s+\d+|level(?:led|ed)?\s*up|gained\s+\d+\s*(?:xp|points)|\+\s*\d+\s*(?:xp|points)/i.test(rawText);
  const selfDigits = [...selfNums]
    .map((id) => String(id).split('@')[0].split(':')[0])
    .filter((n) => n && n.length >= 8);
  const levelNoticeTagsSelf = levelNotice
    && (mentionedBot || selfDigits.some((n) => rawText.includes(n)));

  const suppressedBy = [];
  if (massTagBroadcast) suppressedBy.push('mass-tag broadcast');
  if (knownBot) suppressedBy.push('known bot sender');
  if (botSignature && (/\b(?:ai|bot|assistant)\b/i.test(String(msg?.pushName || '')) || mentionedBot)) {
    suppressedBy.push('bot signature');
  }
  if (levelNoticeTagsSelf) suppressedBy.push('level/XP notice');
  if (isGroup && isForwarded && namedBot && !mentionCall && !repliedToBot && !commandPlugins.parseCommand(cleanText).hadPrefix && !explicitCommandCall && !builtInCommand && !viewOnceCommand && !quotedInvestigateCall) {
    suppressedBy.push('forwarded name mention');
  }

  const wakeReasons = [];
  if (forwardedNameWake) wakeReasons.push('Nick name in text');
  if (mentionCall) wakeReasons.push(isGroup ? 'group mention of Nick' : 'direct mention of Nick');
  if (quotedInvestigateCall) wakeReasons.push('quoted investigation request');
  if (commandPlugins.parseCommand(cleanText).hadPrefix) wakeReasons.push('command prefix');
  if (builtInCommand) wakeReasons.push('built-in command');
  if (viewOnceCommand) wakeReasons.push('view-once command');
  if (explicitCommandCall) wakeReasons.push('listed command');
  if (repliedToBot) wakeReasons.push('reply to Nick');

  return {
    rawText,
    mentions,
    mentionCount,
    mentionedBot,
    taggedOtherUser,
    isForwarded,
    massTagBroadcast,
    groupMentionCall,
    repliedToBot,
    callText,
    namedBot,
    cleanText,
    replyContextInfo,
    quotedPayload,
    quotedCallText,
    quotedInvestigateCall,
    builtInCommand,
    viewOnceCommand,
    mentionCall,
    joinLike,
    joinPayload,
    leaveLike,
    leaveValid,
    explicitCommandCall,
    explicitCall,
    isAddressed,
    isBareCall,
    knownBot,
    botSignature,
    levelNoticeTagsSelf,
    suppressedBy,
    wakeReasons,
    wouldWake: (isAddressed || isBareCall) && suppressedBy.length === 0,
  };
}

module.exports = { evaluateCallGate };
