#!/usr/bin/env node
/**
 * daemon.mjs — WeChat ClawBot ↔ Claude Code bridge daemon
 *
 * Usage:
 *   node daemon.mjs --setup    # QR code login
 *   node daemon.mjs            # Start bridge daemon
 */

import { ILinkClient } from './ilink-client.mjs';
import { chat, closeSession } from './llm.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DATA_DIR = process.env.WECHAT_BRIDGE_DATA_DIR || join(homedir(), '.wechat-bridge');
const STATE_FILE = join(DATA_DIR, 'state.json');
const DEFAULT_MODEL = process.env.WECHAT_BRIDGE_MODEL || 'claude-sonnet-4-6';

mkdirSync(DATA_DIR, { recursive: true });

// --- State management ---

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf-8')); }
  catch { return { sessionId: null, model: DEFAULT_MODEL }; }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- Command handler ---

const COMMANDS = {
  '/new': (state) => {
    closeSession();
    state.sessionId = null;
    saveState(state);
    return '🔄 New session created.';
  },
  '/model': (state, args) => {
    if (!args) {
      return `Current model: ${state.model || DEFAULT_MODEL}\n\nAvailable:\n- claude-opus-4-6\n- claude-sonnet-4-6\n\nUsage: /model claude-sonnet-4-6`;
    }
    state.model = args.trim();
    saveState(state);
    return `✅ Model switched to: ${state.model}`;
  },
  '/status': (state) => {
    return `🤖 WeChat Bridge\n\nSession: ${state.sessionId || '(none)'}\nModel: ${state.model || DEFAULT_MODEL}\nUptime: ${Math.floor(process.uptime())}s`;
  },
  '/help': () => {
    return `📋 Commands:\n\n/new — New session (clear context)\n/model [name] — View/switch model\n/status — Show status\n/help — Show help`;
  },
};

function handleCommand(text, state) {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const handler = COMMANDS[cmd.toLowerCase()];
  if (handler) return handler(state, rest.join(' '));
  return null;
}

// --- Logging ---

function log(...args) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [wechat-bridge]`, ...args);
}

function logError(...args) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.error(`[${ts}] [wechat-bridge]`, ...args);
}

// --- Main ---

async function setup() {
  const client = new ILinkClient();
  await client.login();
  log('Setup complete. Start the daemon with: node daemon.mjs');
}

async function runDaemon() {
  const client = new ILinkClient();

  if (!client.isLoggedIn) {
    logError('Not logged in. Run: node daemon.mjs --setup');
    process.exit(1);
  }

  const state = loadState();
  log('Daemon started. Session:', state.sessionId || '(new)');

  let processing = false;

  while (true) {
    try {
      const messages = await client.getUpdates();

      for (const msg of messages) {
        if (processing) {
          log(`Skipping message from ${msg.chatId} — still processing`);
          continue;
        }

        processing = true;
        log(`Message from ${msg.chatId}: ${msg.text.slice(0, 50)}...`);

        try {
          // Slash commands
          if (msg.text.startsWith('/')) {
            const reply = handleCommand(msg.text, state);
            if (reply) {
              await client.sendMessage(msg.chatId, reply, msg.contextToken);
              log(`Command handled: ${msg.text.split(/\s/)[0]}`);
              processing = false;
              continue;
            }
          }

          // Delayed typing: only send if Claude takes > 2s
          const typingAbort = new AbortController();
          const typingTimer = setTimeout(() => {
            if (!typingAbort.signal.aborted) {
              client.sendTyping(msg.chatId, msg.contextToken, typingAbort.signal).catch(() => {});
            }
          }, 2000);

          // Call Claude
          let responseText = '';
          const model = state.model || DEFAULT_MODEL;
          for await (const chunk of chat(msg.text, state.sessionId, model)) {
            if (chunk.type === 'text') responseText = chunk.text;
            if (chunk.type === 'done') {
              responseText = chunk.text || responseText;
              if (chunk.sessionId) {
                state.sessionId = chunk.sessionId;
                saveState(state);
              }
            }
          }

          // Cancel typing
          clearTimeout(typingTimer);
          typingAbort.abort();

          if (responseText) {
            const chunks = splitMessage(responseText, 4000);
            for (const chunk of chunks) {
              const sent = await client.sendMessage(msg.chatId, chunk, msg.contextToken);
              if (!sent) logError(`Failed to send reply to ${msg.chatId}`);
              if (chunks.length > 1) await new Promise(r => setTimeout(r, 500));
            }
            log(`Reply sent to ${msg.chatId} (${responseText.length} chars)`);
          } else {
            logError('Empty response from Claude');
          }
        } catch (err) {
          logError(`Error processing message: ${err.message}`);
          try {
            await client.sendMessage(msg.chatId, `⚠️ Error: ${err.message}`, msg.contextToken);
          } catch {}
        } finally {
          processing = false;
        }
      }
    } catch (err) {
      if (err.name === 'TimeoutError' || err.message?.includes('timeout')) continue;
      logError(`Poll error: ${err.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { parts.push(remaining); break; }
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.5) splitAt = maxLen;
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return parts;
}

// --- Entry point ---

const args = process.argv.slice(2);

if (args.includes('--setup')) {
  setup().catch(err => { logError('Setup failed:', err.message); process.exit(1); });
} else {
  process.on('SIGTERM', () => { log('SIGTERM'); closeSession(); process.exit(0); });
  process.on('SIGINT', () => { log('SIGINT'); closeSession(); process.exit(0); });
  runDaemon().catch(err => { logError('Daemon crashed:', err.message); process.exit(1); });
}
