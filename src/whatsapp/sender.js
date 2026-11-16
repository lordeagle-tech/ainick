const fs = require('fs');
const logger = require('../logger');
const { chunkText } = require('../utils/helpers');
const chatFont = require('../utils/chatFont');

function makeSender(sock) {
  // Sanitize outgoing text: collapse runs of blank lines to one, and strip
  // asterisks/slashes that render as ugly artifacts in WhatsApp.
  function sanitize(text) {
    let s = String(text || '');

    // Never leak model scratch/thought markers or tool-ish wrappers into WhatsApp.
    s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
    s = s.replace(/<think>|<\/?thinking>|\/?think>/gi, '');
    s = s.replace(/\/?(?:tool|function|json)\b/gi, '');

    // Convert common Markdown into plain WhatsApp-safe text.
    s = s.replace(/```[\w.+#-]*\n?/g, '').replace(/```/g, '');
    s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, '$1 $2');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 $2');
    s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
    s = s.replace(/^\s*[-*+]\s+/gm, '• ');
    s = s.replace(/^\s*>\s?/gm, '');
    s = s.replace(/\*{1,3}([^*\n]+)\*{1,3}/g, '$1');
    s = s.replace(/_{1,3}([^_\n]+)_{1,3}/g, '$1');
    s = s.replace(/~{1,2}([^~\n]+)~{1,2}/g, '$1');
    s = s.replace(/`([^`\n]+)`/g, '$1');

    // Protect URLs before removing stray slash characters.
    const urls = [];
    s = s.replace(/https?:\/\/[^\s]+/g, (m) => {
      urls.push(m);
      return `\u0000${urls.length - 1}\u0000`;
    });
    s = s.replace(/\/{2,}/g, ' ').replace(/(?<!\w)\/(?!\w)/g, '');
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => urls[Number(i)]);

    s = s.replace(/[\u200B-\u200D\uFEFF]/g, '');
    s = s.replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n');
    return s.trim();
  }

  async function sendText(jid, text, opts = {}) {
    const styledText = opts.skipFont ? String(text || '') : chatFont.apply(jid, text);
    const cleaned = sanitize(styledText);
    // Baileys accepts an empty text payload but WhatsApp renders it as a blank
    // bubble.  Treat it as a no-op instead of emitting invisible messages.
    if (!cleaned) return null;
    const parts = chunkText(cleaned, 4000).filter(Boolean);
    // Never tag with @lid — WhatsApp needs phone JIDs for real mentions
    const sendOpts = { ...opts };
    if (Array.isArray(sendOpts.mentions) && sendOpts.mentions.length) {
      try {
        const names = require('../features').names;
        sendOpts.mentions = names.normalizeMentions(sendOpts.mentions, sendOpts.groupMeta);
      } catch {
        sendOpts.mentions = sendOpts.mentions
          .map((j) => {
            const s = String(j || '');
            if (s.endsWith('@s.whatsapp.net')) return s;
            if (s.endsWith('@lid')) return null;
            const n = s.replace(/\D/g, '');
            return n.length >= 8 ? `${n}@s.whatsapp.net` : null;
          })
          .filter(Boolean);
      }
    }
    let lastMsg = null;
    for (const part of parts) {
      try {
        lastMsg = await sock.sendMessage(jid, { text: part, ...(sendOpts.mentions?.length ? { mentions: sendOpts.mentions } : {}) }, sendOpts);
      } catch (e) {
        logger.warn({ err: e.message }, 'send text failed');
      }
    }
    return lastMsg;
  }

  /** Returns { ok, error }. Kept as a rich object (not just a boolean) so callers — like the
   *  build_website/build_project tools — can tell the model and the user *why* a send failed
   *  instead of just going quiet. */
  function mimeFromName(name) {
    const ext = String(name || '').split('.').pop().toLowerCase();
    const map = {
      html: 'text/html', htm: 'text/html', js: 'text/javascript', mjs: 'text/javascript',
      css: 'text/css', json: 'application/json', txt: 'text/plain', md: 'text/markdown',
      csv: 'text/csv', xml: 'application/xml', pdf: 'application/pdf',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
      mp4: 'video/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
      zip: 'application/zip', rar: 'application/x-rar-compressed',
      py: 'text/x-python', ts: 'text/typescript', tsx: 'text/typescript', go: 'text/x-go', rs: 'text/rust',
      vcf: 'text/vcard', svg: 'image/svg+xml',
      sh: 'text/x-shellscript', bash: 'text/x-shellscript', c: 'text/x-c', cpp: 'text/x-c++',
      h: 'text/x-c', java: 'text/x-java', rb: 'text/x-ruby', php: 'application/x-httpd-php',
      sql: 'application/sql', yaml: 'text/yaml', yml: 'text/yaml', toml: 'text/plain',
      log: 'text/plain', conf: 'text/plain', env: 'text/plain', dockerfile: 'text/plain',
      apk: 'application/vnd.android.package-archive', exe: 'application/octet-stream',
      '7z': 'application/x-7z-compressed', tar: 'application/x-tar', gz: 'application/gzip',
    };
    return map[ext] || 'application/octet-stream';
  }

  async function sendFile(jid, filePath, fileName, caption) {
    try {
      const data = Buffer.isBuffer(filePath) ? filePath : fs.readFileSync(filePath);
      if (!data.length) throw new Error('file was empty (0 bytes)');
      const name = fileName || (Buffer.isBuffer(filePath) ? 'file.bin' : require('path').basename(filePath));
      const mimetype = mimeFromName(name);
      await sock.sendMessage(jid, {
        document: data,
        mimetype,
        fileName: name,
        caption: chatFont.apply(jid, caption || ''),
      });
      return { ok: true, mimetype, fileName: name };
    } catch (e) {
      logger.warn({ err: e.message, filePath, fileName }, 'send file failed');
      return { ok: false, error: e.message };
    }
  }


  async function sendAudio(jid, source, opts = {}) {
    try {
      let buffer = null;
      if (Buffer.isBuffer(source)) buffer = source;
      else if (typeof source === 'string' && /^https?:\/\//i.test(source)) {
        const axios = require('axios');
        const r = await axios.get(source, { responseType: 'arraybuffer', timeout: 120000, maxContentLength: 80 * 1024 * 1024 });
        buffer = Buffer.from(r.data);
      } else if (typeof source === 'string' && require('fs').existsSync(source)) {
        buffer = require('fs').readFileSync(source);
      }
      if (!buffer || !buffer.length) throw new Error('empty audio buffer');

      // WhatsApp linked-device sessions often hide audio/mpeg bubbles.
      // OGG opus is the native WhatsApp voice format and renders everywhere.
      const ptt = !!opts.ptt;
      const isOgg = buffer[0] === 0x4F && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53;
      const mimetype = opts.mimetype || (isOgg ? 'audio/ogg; codecs=opus' : (ptt ? 'audio/ogg; codecs=opus' : 'audio/mpeg'));
      const fileName = opts.fileName || (ptt ? 'voice.ogg' : (isOgg ? 'audio.ogg' : 'audio.mp3'));
      const payload = {
        audio: buffer,
        mimetype,
        ptt,
        fileName,
      };
      if (opts.seconds) payload.seconds = Number(opts.seconds) || undefined;
      if (opts.contextInfo) payload.contextInfo = opts.contextInfo;

      let last = await sock.sendMessage(jid, payload, opts.quoted ? { quoted: opts.quoted } : undefined);

      // Some clients hide audio bubbles from linked-device sessions. Document fallback
      // always shows as a downloadable file so the user still gets the track.
      if (opts.alsoAsDocument) {
        try {
          await sock.sendMessage(jid, {
            document: buffer,
            mimetype: mimetype.includes('ogg') ? 'audio/ogg' : 'audio/mpeg',
            fileName,
          }, opts.quoted ? { quoted: opts.quoted } : undefined);
        } catch {}
      }
      return last || true;
    } catch (e) {
      logger.warn({ err: e.message }, 'send audio failed');
      // Last resort: document attachment
      try {
        const buffer = Buffer.isBuffer(source) ? source : null;
        if (buffer?.length) {
          await sock.sendMessage(jid, {
            document: buffer,
            mimetype: opts.mimetype || 'audio/mpeg',
            fileName: opts.fileName || 'audio.mp3',
          });
          return true;
        }
      } catch (e2) {
        logger.warn({ err: e2.message }, 'audio document fallback failed');
      }
      return false;
    }
  }

  async function sendSticker(jid, buffer, opts = {}) {
    try {
      await sock.sendMessage(jid, { sticker: buffer }, opts.quoted ? { quoted: opts.quoted } : undefined);
      return true;
    } catch (e) {
      logger.warn({ err: e.message }, 'send sticker failed');
      return false;
    }
  }

  /** source: a Buffer, or a remote https URL string (e.g. from an AI image-gen result). */
  async function sendImage(jid, source, caption, opts = {}) {
    try {
      const image = Buffer.isBuffer(source) ? source : { url: source };
      await sock.sendMessage(jid, { image, caption: chatFont.apply(jid, caption || '') }, opts.quoted ? { quoted: opts.quoted } : undefined);
      return true;
    } catch (e) {
      logger.warn({ err: e.message }, 'send image failed');
      return false;
    }
  }

  /** source: a Buffer, or a remote https URL string (e.g. from an AI video-gen result). */
  async function sendVideo(jid, source, caption, opts = {}) {
    try {
      let video;
      if (Buffer.isBuffer(source)) {
        video = source;
      } else if (typeof source === 'string' && /^https?:\/\//i.test(source)) {
        try {
          const axios = require('axios');
          const r = await axios.get(source, {
            responseType: 'arraybuffer',
            timeout: 180000,
            maxContentLength: 100 * 1024 * 1024,
            headers: { 'User-Agent': 'Mozilla/5.0' },
          });
          video = Buffer.from(r.data);
        } catch (e) {
          // Never pass raw URLs to Baileys - they often fail silently.
          // Try one more time with longer timeout
          try {
            const axios2 = require('axios');
            const r2 = await axios2.get(source, {
              responseType: 'arraybuffer',
              timeout: 240000,
              maxContentLength: 100 * 1024 * 1024,
              headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' },
            });
            video = Buffer.from(r2.data);
          } catch (e2) {
            logger.warn({ err: e2.message }, 'sendVideo: all download attempts failed');
            throw new Error('Video download failed: ' + (e2.message || e.message));
          }
        }
      } else if (typeof source === 'string') {
        // Local file path
        const fs = require('fs');
        if (fs.existsSync(source)) { video = fs.readFileSync(source); }
        else { throw new Error('Video file not found: ' + source); }
      }
      await sock.sendMessage(
        jid,
        { video, caption: chatFont.apply(jid, caption || ''), mimetype: 'video/mp4' },
        opts.quoted ? { quoted: opts.quoted } : undefined,
      );
      return true;
    } catch (e) {
      logger.warn({ err: e.message }, 'send video failed');
      // Fallback: send as document so user at least gets the file
      try {
        if (Buffer.isBuffer(video)) {
          await sock.sendMessage(jid, {
            document: video,
            mimetype: 'video/mp4',
            fileName: (caption || 'video').slice(0, 60).replace(/[\\/:*?"<>|]+/g, ' ') + '.mp4',
          }, opts.quoted ? { quoted: opts.quoted } : undefined);
          return true;
        }
      } catch (e2) { logger.warn({ err: e2.message }, 'video document fallback failed'); }
      return false;
    }
  }

  async function typing(jid, on = true) {
    if (!require('../features').autoPresence.isTypingEnabled()) return;
    try {
      await sock.sendPresenceUpdate(on ? 'composing' : 'paused', jid);
    } catch {}
  }

  async function deleteMessage(jid, key) {
    // Must throw so callers know the delete failed (previously errors were swallowed).
    const payload = {
      remoteJid: key.remoteJid || jid,
      id: key.id,
      fromMe: !!key.fromMe,
    };
    if (key.participant) payload.participant = key.participant;
    if (key.participantAlt) payload.participantAlt = key.participantAlt;
    await sock.sendMessage(jid, { delete: payload });
  }

  return { sendText, sendFile, sendAudio, sendSticker, sendImage, sendVideo, typing, deleteMessage };
}

module.exports = { makeSender };
