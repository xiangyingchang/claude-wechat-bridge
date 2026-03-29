/**
 * llm.mjs — Claude Agent SDK wrapper with V2 Session Keepalive
 *
 * Uses unstable_v2_createSession for persistent subprocess keepalive.
 * The Claude Code process stays alive between messages, eliminating
 * 2-3s cold start on subsequent messages.
 *
 * Optionally injects workspace context files (SOUL.md, USER.md, etc.)
 * on session creation for personality/memory continuity.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);

// Resolve Agent SDK — check common locations
const SDK_PKG = '@anthropic-ai/claude-agent-sdk';
const SDK_CANDIDATES = [
  join(homedir(), '.claude/skills/claude-to-im/node_modules', SDK_PKG),
  join(homedir(), '.claude-internal/skills/claude-to-im/node_modules', SDK_PKG),
  SDK_PKG, // global / NODE_PATH fallback
];

let sdk;
for (const candidate of SDK_CANDIDATES) {
  try {
    sdk = require(candidate);
    break;
  } catch { /* try next */ }
}
if (!sdk) {
  console.error(`Error: Could not find ${SDK_PKG}. Install it or ensure claude-to-im plugin is installed.`);
  process.exit(1);
}

const { unstable_v2_createSession, query: queryFn } = sdk;

const HAS_V2 = typeof unstable_v2_createSession === 'function';
if (!HAS_V2) {
  console.warn('[llm] V2 Session API not available, falling back to V1 query() per-message');
}

const CLAUDE_BIN = process.env.CLAUDE_CODE_EXECUTABLE
  || process.env.CLAUDE_CODE_TEAMMATE_COMMAND
  || 'claude';

const WORK_DIR = process.env.WECHAT_BRIDGE_CWD || process.cwd();

const DEFAULT_MODEL = process.env.WECHAT_BRIDGE_MODEL || 'claude-sonnet-4-6';

const SESSION_TTL = parseInt(process.env.WECHAT_BRIDGE_SESSION_TTL || '1800000', 10); // 30 min

// --- Context file injection ---

const CONTEXT_FILES = (process.env.WECHAT_BRIDGE_CONTEXT_FILES || '').split(',').filter(Boolean);

function loadWorkspaceContext() {
  if (CONTEXT_FILES.length === 0) return '';

  let context = '# Project Context\n以下文件已自动加载，请严格遵守其中的规则和人格设定。\n\n';
  for (const filePath of CONTEXT_FILES) {
    const resolved = filePath.startsWith('/') ? filePath : join(WORK_DIR, filePath);
    try {
      const content = readFileSync(resolved, 'utf-8');
      if (content.trim()) {
        const name = filePath.split('/').pop();
        const truncated = content.length > 20000
          ? content.slice(0, 14000) + '\n\n[...truncated...]\n\n' + content.slice(-4000)
          : content;
        context += `## ${name}\n${truncated}\n\n`;
      }
    } catch {
      // File missing — skip
    }
  }
  return context;
}

// --- V2 Session State ---

let activeSession = null;
let activeSessionId = null;
let activeModel = null;
let lastActivityTime = 0;

function buildOptions(model) {
  return {
    model: model || DEFAULT_MODEL,
    pathToClaudeCodeExecutable: CLAUDE_BIN,
    permissionMode: 'bypassPermissions',
  };
}

function shouldRecreateSession(requestedSessionId, model) {
  if (!activeSession) return true;
  if (Date.now() - lastActivityTime > SESSION_TTL) return true;
  if (model && model !== activeModel) return true;
  if (requestedSessionId === null && activeSessionId !== null) return true;
  return false;
}

export function closeSession() {
  if (activeSession) {
    try { activeSession.close(); } catch {}
    console.log(`[llm] Session closed: ${activeSessionId}`);
    activeSession = null;
    activeSessionId = null;
    activeModel = null;
  }
}

export async function* chat(prompt, sessionId, model, _retryCount = 0) {
  if (!HAS_V2) {
    yield* chatV1(prompt, sessionId, model);
    return;
  }

  if (shouldRecreateSession(sessionId, model)) {
    closeSession();
    const options = buildOptions(model);
    activeModel = model || DEFAULT_MODEL;

    try {
      console.log(`[llm] Creating new session (model=${activeModel})`);
      activeSession = unstable_v2_createSession(options);

      // Inject workspace context if configured
      const context = loadWorkspaceContext();
      if (context.length > 100) {
        console.log(`[llm] Injecting workspace context (${context.length} chars)`);
        await activeSession.send(context + '\n\nConfirm you have read the above. Reply "OK" only.');
        for await (const event of activeSession.stream()) { /* drain */ }
        console.log('[llm] Context injection complete');
      }
    } catch (err) {
      console.error(`[llm] Session creation failed: ${err.message}, falling back to V1`);
      yield* chatV1(prompt, sessionId, model);
      return;
    }
  } else {
    console.log(`[llm] Reusing session: ${activeSessionId} (keepalive)`);
  }

  lastActivityTime = Date.now();

  try {
    await activeSession.send(prompt);

    let lastText = '';
    let hasError = false;
    for await (const event of activeSession.stream()) {
      if (event.type === 'assistant' && event.message) {
        const content = event.message.content;
        if (Array.isArray(content)) {
          const texts = content.filter(b => b.type === 'text').map(b => b.text);
          if (texts.length) {
            lastText = texts.join('\n');
            yield { type: 'text', text: lastText };
          }
        } else if (typeof content === 'string') {
          lastText = content;
          yield { type: 'text', text: lastText };
        }
      }

      if (event.type === 'result') {
        if (event.subtype === 'error_during_execution' || event.is_error) {
          console.error(`[llm] Session error: ${event.subtype} — ${event.result || 'unknown'}`);
          hasError = true;
        }
        lastText = event.result || lastText;
        activeSessionId = event.session_id || activeSession.sessionId || activeSessionId;
      }
    }

    if (hasError && !lastText) {
      if (_retryCount >= 1) {
        console.error('[llm] Session errored twice, giving up');
        yield { type: 'done', text: '⚠️ Processing failed. Send /new to reset.', sessionId: activeSessionId };
        return;
      }
      console.log('[llm] Session errored, retrying with fresh session');
      closeSession();
      yield* chat(prompt, null, model, _retryCount + 1);
      return;
    }

    try { activeSessionId = activeSession.sessionId; } catch {}
    yield { type: 'done', text: lastText, sessionId: activeSessionId };
  } catch (err) {
    console.error(`[llm] V2 session error: ${err.message}`);
    closeSession();
    throw err;
  }
}

async function* chatV1(prompt, sessionId, model) {
  const options = {
    model: model || DEFAULT_MODEL,
    cwd: WORK_DIR,
    pathToClaudeCodeExecutable: CLAUDE_BIN,
    permissionMode: 'bypassPermissions',
  };
  if (sessionId) options.resume = sessionId;

  const conversation = queryFn({ prompt, options });
  let lastText = '';
  let resultSessionId = sessionId;

  for await (const event of conversation) {
    if (event.type === 'assistant' && event.message) {
      const content = event.message.content;
      if (Array.isArray(content)) {
        const texts = content.filter(b => b.type === 'text').map(b => b.text);
        if (texts.length) {
          lastText = texts.join('\n');
          yield { type: 'text', text: lastText };
        }
      } else if (typeof content === 'string') {
        lastText = content;
        yield { type: 'text', text: lastText };
      }
    }
    if (event.type === 'result') {
      lastText = event.result || lastText;
      resultSessionId = event.session_id || resultSessionId;
    }
  }

  yield { type: 'done', text: lastText, sessionId: resultSessionId };
}
