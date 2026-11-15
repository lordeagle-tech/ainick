// telegram/api.js — Telegram Bot API client (axios + native FormData)
const axios = require('axios');
const logger = require('../logger');

/** Convert WhatsApp-style *bold* / _italic_ to Telegram HTML. Strip leftover lone * */
function formatTelegramHtml(text) {
  let s = String(text || '');
  // Escape HTML special chars first (except we will add tags)
  s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // **bold** or *bold* → <b>
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/\*([^*\n]+)\*/g, '<b>$1</b>');
  // _italic_
  s = s.replace(/(^|[^a-zA-Z0-9])_([^_\n]+)_(?![a-zA-Z0-9])/g, '$1<i>$2</i>');
  // `code`
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // Remove any remaining unpaired asterisks (the "showing asterisk" problem)
  s = s.replace(/\*/g, '');
  return s;
}

function client(token) {
  const base = `https://api.telegram.org/bot${token}`;
  const fileBase = `https://api.telegram.org/file/bot${token}`;

  async function call(method, payload = {}) {
    try {
      const { data } = await axios.post(`${base}/${method}`, payload, { timeout: 120000 });
      if (!data?.ok) throw new Error(data?.description || `${method} failed`);
      return data.result;
    } catch (e) {
      const desc = e.response?.data?.description || e.message;
      throw new Error(`Telegram ${method}: ${desc}`);
    }
  }

  async function callMultipart(method, form) {
    const { data } = await axios.post(`${base}/${method}`, form, {
      timeout: 180000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      headers: form.getHeaders ? form.getHeaders() : { 'Content-Type': 'multipart/form-data' },
    });
    if (!data?.ok) throw new Error(data?.description || `${method} failed`);
    return data.result;
  }

  function buildForm(fields, fileField, buffer, fileName, contentType) {
    // Prefer form-data package if present; else native FormData + Blob (Node 20+)
    try {
      const FormData = require('form-data');
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined && v !== null) form.append(k, String(v));
      }
      form.append(fileField, buffer, { filename: fileName, contentType });
      return form;
    } catch {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined && v !== null) form.append(k, String(v));
      }
      form.append(fileField, new Blob([buffer], { type: contentType }), fileName);
      return form;
    }
  }

  return {
    getMe: () => call('getMe'),
    getUpdates: (offset, timeout = 25) =>
      call('getUpdates', {
        offset,
        timeout,
        allowed_updates: ['message'],
      }),
    sendMessage: async (chatId, text, extra = {}) => {
      const raw = String(text || '').slice(0, 4090);
      const useHtml = extra.parse_mode !== false && extra.parse_mode !== 'plain';
      const body = useHtml ? formatTelegramHtml(raw) : raw;
      try {
        return await call('sendMessage', {
          chat_id: chatId,
          text: body,
          parse_mode: useHtml ? (extra.parse_mode === 'Markdown' ? 'Markdown' : 'HTML') : undefined,
          reply_to_message_id: extra.reply_to,
          disable_web_page_preview: true,
        });
      } catch (e) {
        // Fallback plain if HTML parse fails
        if (useHtml) {
          return call('sendMessage', {
            chat_id: chatId,
            text: raw.replace(/\*/g, ''),
            reply_to_message_id: extra.reply_to,
            disable_web_page_preview: true,
          });
        }
        throw e;
      }
    },
    async sendPhoto(chatId, source, caption, extra = {}) {
      if (typeof source === 'string' && /^https?:\/\//i.test(source)) {
        return call('sendPhoto', {
          chat_id: chatId,
          photo: source,
          caption: caption ? String(caption).slice(0, 1000) : undefined,
          reply_to_message_id: extra.reply_to,
        });
      }
      const buf = Buffer.isBuffer(source) ? source : Buffer.from(source);
      const fields = { chat_id: chatId, caption: caption ? String(caption).slice(0, 1000) : undefined, reply_to_message_id: extra.reply_to };
      const form = buildForm(fields, 'photo', buf, 'photo.jpg', 'image/jpeg');
      return callMultipart('sendPhoto', form);
    },
    async sendDocument(chatId, buffer, fileName, caption, extra = {}) {
      const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      const fields = {
        chat_id: chatId,
        caption: caption ? String(caption).slice(0, 1000) : undefined,
        reply_to_message_id: extra.reply_to,
      };
      const form = buildForm(fields, 'document', buf, fileName || 'file.bin', 'application/octet-stream');
      return callMultipart('sendDocument', form);
    },
    async sendVideo(chatId, buffer, caption, extra = {}) {
      const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      const fields = {
        chat_id: chatId,
        caption: caption ? String(caption).slice(0, 1000) : undefined,
        reply_to_message_id: extra.reply_to,
      };
      const form = buildForm(fields, 'video', buf, 'video.mp4', 'video/mp4');
      return callMultipart('sendVideo', form);
    },
    async sendAudio(chatId, buffer, extra = {}) {
      const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      const fields = {
        chat_id: chatId,
        caption: extra.caption ? String(extra.caption).slice(0, 1000) : undefined,
        reply_to_message_id: extra.reply_to,
      };
      const form = buildForm(fields, 'audio', buf, extra.fileName || 'audio.mp3', 'audio/mpeg');
      return callMultipart('sendAudio', form);
    },
    sendChatAction: (chatId, action = 'typing') =>
      call('sendChatAction', { chat_id: chatId, action }).catch(() => null),
    getFile: (fileId) => call('getFile', { file_id: fileId }),
    async downloadFile(filePath) {
      const { data } = await axios.get(`${fileBase}/${filePath}`, {
        responseType: 'arraybuffer',
        timeout: 120000,
      });
      return Buffer.from(data);
    },
  };
}

module.exports = { client };
