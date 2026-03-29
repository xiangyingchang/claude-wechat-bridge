/**
 * ilink-client.mjs — WeChat ClawBot iLink API client
 *
 * Handles: QR login, long-poll message receiving, text sending, typing indicators.
 * Base URL: https://ilinkai.weixin.qq.com
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const BASE_URL = 'https://ilinkai.weixin.qq.com';
const CHANNEL_VERSION = '0.2.0';
const DATA_DIR = process.env.WECHAT_BRIDGE_DATA_DIR || join(homedir(), '.wechat-bridge');
const CRED_FILE = join(DATA_DIR, 'credentials.json');
const SYNC_FILE = join(DATA_DIR, 'sync_buf.txt');
const CTX_FILE = join(DATA_DIR, 'context_tokens.json');

function randomWechatUin() {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function generateClientId() {
  return `wechat-bridge:${Date.now()}-${randomBytes(4).toString('hex')}`;
}

function baseInfo() {
  return { channel_version: CHANNEL_VERSION };
}

export class ILinkClient {
  constructor() {
    mkdirSync(DATA_DIR, { recursive: true });
    this.credentials = this._loadCredentials();
    this.syncBuf = this._loadSyncBuf();
    this.contextTokens = this._loadContextTokens();
  }

  get isLoggedIn() {
    return !!this.credentials?.token;
  }

  // --- Auth ---

  async login() {
    console.log('[ilink] Fetching QR code...');
    const res = await fetch(`${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`);
    const data = await res.json();

    if (!data.qrcode) {
      throw new Error('Failed to get QR code: ' + JSON.stringify(data));
    }

    // Display QR code URL for scanning
    const qrUrl = data.qrcode_img_content;
    if (qrUrl) {
      console.log('[ilink] Scan this URL with WeChat:');
      console.log(`[ilink] ${qrUrl}`);

      // Try to open in browser (macOS/Linux)
      try {
        const { execSync } = await import('node:child_process');
        const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
        execSync(`${openCmd} "${qrUrl}"`, { timeout: 5000, stdio: 'ignore' });
      } catch {
        console.log('[ilink] Open the URL above in a browser to scan.');
      }
    }

    // Poll for scan status
    const deadline = Date.now() + 8 * 60 * 1000; // 8 minutes
    while (Date.now() < deadline) {
      const statusRes = await fetch(
        `${BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(data.qrcode)}`,
        { headers: { 'iLink-App-ClientVersion': '1' } }
      );
      const status = await statusRes.json();

      if (status.status === 'confirmed') {
        this.credentials = {
          token: status.bot_token,
          baseUrl: status.baseurl || BASE_URL,
          accountId: status.ilink_bot_id,
          userId: status.ilink_user_id,
          savedAt: new Date().toISOString(),
        };
        this._saveCredentials();
        console.log('[ilink] Login successful!');
        return this.credentials;
      }

      if (status.status === 'expired') {
        throw new Error('QR code expired. Run setup again.');
      }

      console.log(`[ilink] Status: ${status.status}...`);
      await new Promise(r => setTimeout(r, 2000));
    }

    throw new Error('Login timeout (8 minutes).');
  }

  // --- Receive Messages ---

  async getUpdates() {
    if (!this.isLoggedIn) throw new Error('Not logged in');

    const res = await fetch(`${BASE_URL}/ilink/bot/getupdates`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'AuthorizationType': 'ilink_bot_token',
        'Authorization': `Bearer ${this.credentials.token}`,
        'X-WECHAT-UIN': randomWechatUin(),
      },
      body: JSON.stringify({
        get_updates_buf: this.syncBuf,
        base_info: baseInfo(),
      }),
      signal: AbortSignal.timeout(40000),
    });

    const data = await res.json();

    if (data.ret && data.ret !== 0) {
      throw new Error(`getUpdates error: ret=${data.ret} ${data.errmsg || ''}`);
    }
    if (data.errcode && data.errcode !== 0) {
      throw new Error(`getUpdates error: errcode=${data.errcode} ${data.errmsg || ''}`);
    }

    // Update sync state
    if (data.get_updates_buf) {
      this.syncBuf = data.get_updates_buf;
      this._saveSyncBuf();
    }

    // Filter and parse incoming user messages
    const messages = (data.msgs || [])
      .filter(m => m.message_type === 1 && m.message_state === 2)
      .map(m => {
        const chatId = m.group_id || m.from_user_id;
        if (m.context_token && chatId) {
          this.contextTokens[chatId] = m.context_token;
          this._saveContextTokens();
        }

        let text = '';
        for (const item of (m.item_list || [])) {
          if (item.type === 1 && item.text_item?.text) text += item.text_item.text;
          if (item.type === 3 && item.voice_item?.text) text += item.voice_item.text;
        }

        return {
          messageId: m.client_id,
          fromUserId: m.from_user_id,
          groupId: m.group_id,
          chatId,
          sessionId: m.session_id,
          text: text.trim(),
          contextToken: m.context_token,
          timestamp: m.create_time_ms,
        };
      })
      .filter(m => m.text);

    return messages;
  }

  // --- Send Message ---

  async sendMessage(toUserId, text, contextToken) {
    if (!this.isLoggedIn) throw new Error('Not logged in');

    const ctx = contextToken || this.contextTokens[toUserId];
    if (!ctx) {
      console.error(`[ilink] No context_token for ${toUserId}, cannot reply`);
      return false;
    }

    const res = await fetch(`${BASE_URL}/ilink/bot/sendmessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'AuthorizationType': 'ilink_bot_token',
        'Authorization': `Bearer ${this.credentials.token}`,
        'X-WECHAT-UIN': randomWechatUin(),
      },
      body: JSON.stringify({
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: generateClientId(),
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text } }],
          context_token: ctx,
        },
        base_info: baseInfo(),
      }),
      signal: AbortSignal.timeout(15000),
    });

    const data = await res.json();
    if (data.ret && data.ret !== 0) {
      console.error(`[ilink] sendMessage error: ret=${data.ret} ${data.errmsg || ''}`);
      return false;
    }
    if (data.errcode && data.errcode !== 0) {
      console.error(`[ilink] sendMessage error: errcode=${data.errcode} ${data.errmsg || ''}`);
      return false;
    }
    return true;
  }

  // --- Typing Indicator ---

  async sendTyping(toUserId, contextToken, abortSignal) {
    const ctx = contextToken || this.contextTokens[toUserId];
    if (!ctx) return;

    try {
      const configRes = await fetch(`${BASE_URL}/ilink/bot/getconfig`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'AuthorizationType': 'ilink_bot_token',
          'Authorization': `Bearer ${this.credentials.token}`,
          'X-WECHAT-UIN': randomWechatUin(),
        },
        body: JSON.stringify({
          to_user_id: toUserId,
          ilink_user_id: this.credentials.userId,
          context_token: ctx,
          base_info: baseInfo(),
        }),
        signal: abortSignal || AbortSignal.timeout(5000),
      });
      const config = await configRes.json();
      if (!config.typing_ticket) return;

      await fetch(`${BASE_URL}/ilink/bot/sendtyping`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'AuthorizationType': 'ilink_bot_token',
          'Authorization': `Bearer ${this.credentials.token}`,
          'X-WECHAT-UIN': randomWechatUin(),
        },
        body: JSON.stringify({
          to_user_id: toUserId,
          ilink_user_id: this.credentials.userId,
          typing_ticket: config.typing_ticket,
          context_token: ctx,
          base_info: baseInfo(),
        }),
        signal: abortSignal || AbortSignal.timeout(5000),
      });
    } catch {
      // Fire and forget
    }
  }

  // --- Persistence ---

  _loadCredentials() {
    try { return JSON.parse(readFileSync(CRED_FILE, 'utf-8')); } catch { return null; }
  }
  _saveCredentials() {
    writeFileSync(CRED_FILE, JSON.stringify(this.credentials, null, 2));
  }
  _loadSyncBuf() {
    try { return readFileSync(SYNC_FILE, 'utf-8').trim(); } catch { return ''; }
  }
  _saveSyncBuf() {
    writeFileSync(SYNC_FILE, this.syncBuf);
  }
  _loadContextTokens() {
    try { return JSON.parse(readFileSync(CTX_FILE, 'utf-8')); } catch { return {}; }
  }
  _saveContextTokens() {
    writeFileSync(CTX_FILE, JSON.stringify(this.contextTokens, null, 2));
  }
}
