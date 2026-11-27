import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';

import type { Context, Next } from 'hono';
import type { ApprovalStore } from '../approvals/approvalStore';
import type { ServerConfig } from '../config';
import type { AgentPersona, EncryptedSessionVault } from '../storage/sessionVault';
import type { TelegramAccountRuntime } from '../telegram/types';

import { createTelegramMcpHandler, MCP_TOOL_CATALOG } from '../mcp/createMcpHandler';
import {
  createSignedSessionCookie,
  deriveAes256Key,
  generateStrongToken,
  hashSecretToken,
  verifyConstantTimeString,
  verifySignedSessionCookie,
  verifyTokenAgainstHashes,
} from '../security/crypto';

export type AppContextDeps = {
  config: ServerConfig;
  vault: EncryptedSessionVault;
  approvals: ApprovalStore;
  runtime: TelegramAccountRuntime;
  serverVersion: string;
};

const ADMIN_COOKIE_NAME = 'tg_console_session';
const ADMIN_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours
const MAX_JSON_BODY_BYTES = 256 * 1024; // 256 KB

const LOGIN_BODY_SCHEMA = z.object({
  token: z.string().min(1).max(256),
});

const IMPORT_SESSION_BODY_SCHEMA = z.object({
  label: z.string().trim().max(80).optional(),
  payload: z.unknown(),
});

const SEND_MESSAGE_BODY_SCHEMA = z.object({
  chatId: z.string().trim().min(1).max(64).regex(/^-?\d+$/),
  text: z.string().trim().min(1).max(4096),
  replyToMsgId: z.number().int().positive().optional(),
  confirmedTargetAccountId: z.string().trim().min(3).max(64),
  confirmedTargetChatId: z.string().trim().min(1).max(64),
});

const APPROVE_BODY_SCHEMA = z.object({
  executeNow: z.boolean().optional().default(true),
});

const REJECT_BODY_SCHEMA = z.object({
  reason: z.string().trim().max(200).optional(),
});

const ROTATE_TOKEN_BODY_SCHEMA = z.object({
  keepPrevious: z.boolean().optional().default(true),
});

const AGENT_BODY_SCHEMA = z.object({
  id: z.string().trim().min(5).max(32).optional(),
  name: z.string().trim().min(1).max(80),
  accountId: z.string().trim().min(3).max(64),
  chatId: z.string().trim().min(1).max(64).regex(/^-?\d+$/),
  providerUrl: z.string().url().max(500),
  model: z.string().trim().min(1).max(120),
  persona: z.object({
    name: z.string().trim().max(80),
    role: z.string().trim().max(120),
    region: z.string().trim().max(120),
    dialect: z.string().trim().max(120),
    tone: z.string().trim().max(120),
    formality: z.string().trim().max(80),
    ageStyle: z.string().trim().max(80),
  }).optional(),
  systemPrompt: z.string().trim().min(1).max(12000),
  tools: z.array(z.enum(['read_group_messages', 'search_group_messages', 'reply_to_group'])).max(3),
  memoryMessages: z.number().int().min(20).max(100),
  isEnabled: z.boolean(),
});

const OPENROUTER_MODELS_BODY_SCHEMA = z.object({
});
const OPENROUTER_KEY_BODY_SCHEMA = z.object({ apiKey: z.string().trim().min(1).max(512) });

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models?output_modalities=text&endpoints=%2Fapi%2Fv1%2Fchat%2Fcompletions&supported_parameters=tools&sort=most-popular&limit=100';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.tgs': 'application/octet-stream',
  '.mp4': 'video/mp4',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

export function createServerApp(deps: AppContextDeps) {
  const { config, vault, approvals, runtime, serverVersion } = deps;
  const app = new Hono();

  const cookieSigningKey = deriveAes256Key(`cookie-signing:${config.sessionEncryptionKey}:${config.adminAuthToken}`);
  const adminTokenHash = hashSecretToken(config.adminAuthToken);
  const mcpHandler = createTelegramMcpHandler({
    ownerId: config.ownerId,
    vault,
    approvals,
    runtime,
    serverVersion,
  });

  const updateRuntime = runtime as TelegramAccountRuntime & {
    setIncomingMessageHandler?: (handler: (message: { accountId: string; chatId: string; messageId: number; text: string; isOutgoing: boolean; isMentioned: boolean }) => void) => void;
  };
  updateRuntime.setIncomingMessageHandler?.((message) => {
    if (!message.isOutgoing && message.isMentioned) void handleAgentMessage(message).catch((err: unknown) => {
      void vault.appendAudit({
        actor: 'system', action: 'agent.reply', accountId: message.accountId, target: message.chatId,
        status: 'error', detail: err instanceof Error ? err.message : 'Agent response failed',
      });
    });
  });

  async function handleAgentMessage(message: { accountId: string; chatId: string; messageId: number; text: string }) {
    const agent = vault.listAgents().find((item) => item.accountId === message.accountId && item.chatId === message.chatId && item.isEnabled);
    if (!agent || !agent.tools.includes('reply_to_group')) return;
    const storedAgent = vault.getAgent(agent.id);
    const account = vault.getAuthorizedAccount(config.ownerId, agent.accountId);
    const openRouterApiKey = vault.getOpenRouterApiKey();
    if (!storedAgent || !openRouterApiKey || !account) return;

    const eventId = `${message.accountId}:${message.chatId}:${message.messageId}`;
    const wasAdded = await vault.appendAgentMemory(agent.id, { role: 'user', text: message.text, eventId });
    if (!wasAdded) return;
    const refreshedAgent = vault.getAgent(agent.id)!;
    const memory = refreshedAgent.memory.slice(-Math.max(20, refreshedAgent.memoryMessages));

    const endpoint = `${storedAgent.providerUrl.replace(/\/+$/, '')}/chat/completions`;
    const availableTools = [
      ...(agent.tools.includes('read_group_messages') ? [{ type: 'function', function: { name: 'read_group_messages', description: 'Read recent messages in the configured group', parameters: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 30 } } } } }] : []),
      ...(agent.tools.includes('search_group_messages') ? [{ type: 'function', function: { name: 'search_group_messages', description: 'Search messages in the configured group', parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string', maxLength: 200 } } } } }] : []),
      { type: 'function', function: { name: 'reply_to_group', description: 'Reply to the incoming message in the configured group', parameters: { type: 'object', required: ['text'], properties: { text: { type: 'string', maxLength: 4096 } } } } },
    ];
    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: buildAgentSystemPrompt(storedAgent.persona, storedAgent.systemPrompt) },
      ...memory.map((entry) => ({ role: entry.role, content: entry.text })),
    ];
    let isReplied = false;
    for (let turn = 0; turn < 4; turn += 1) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${openRouterApiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://tg.encryptosystem.com',
          'X-Title': 'Telegram Web Z Console',
        },
        body: JSON.stringify({ model: storedAgent.model, messages, tools: availableTools, tool_choice: 'auto' }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`AI provider returned HTTP ${response.status}`);
      const result = await response.json() as { choices?: { message?: { role?: string; content?: unknown; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[] };
      const assistantMessage = result.choices?.[0]?.message;
      if (!assistantMessage) return;
      messages.push(assistantMessage as Record<string, unknown>);
      const toolCalls = assistantMessage.tool_calls || [];
      if (!toolCalls.length) {
        if (!isReplied && typeof assistantMessage.content === 'string' && assistantMessage.content.trim()) {
          const reply = assistantMessage.content.trim().slice(0, 4096);
          await runtime.sendMessage(account, { chatId: agent.chatId, text: reply, replyToMsgId: message.messageId });
          await vault.appendAgentMemory(agent.id, { role: 'assistant', text: reply });
          isReplied = true;
        }
        break;
      }
      for (const toolCall of toolCalls) {
        const args = JSON.parse(toolCall.function.arguments) as { limit?: number; query?: string; text?: string };
        let output: unknown;
        if (toolCall.function.name === 'read_group_messages' && agent.tools.includes('read_group_messages')) {
          output = await runtime.readMessages(account, { chatId: agent.chatId, limit: Math.max(1, Math.min(args.limit || 12, 30)) });
        } else if (toolCall.function.name === 'search_group_messages' && agent.tools.includes('search_group_messages') && args.query?.trim()) {
          output = await runtime.searchMessages(account, { chatId: agent.chatId, query: args.query.slice(0, 200), limit: 20 });
        } else if (toolCall.function.name === 'reply_to_group' && args.text?.trim() && !isReplied) {
          const reply = args.text.trim().slice(0, 4096);
          output = await runtime.sendMessage(account, { chatId: agent.chatId, text: reply, replyToMsgId: message.messageId });
          await vault.appendAgentMemory(agent.id, { role: 'assistant', text: reply });
          isReplied = true;
        } else {
          output = { error: 'Tool is unavailable or arguments are invalid' };
        }
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(output) });
      }
    }
    await vault.appendAudit({ actor: 'system', action: 'agent.reply', accountId: agent.accountId, target: agent.chatId, status: 'ok', detail: `Agent ${agent.name} processed an incoming message` });
  }

  // Global security headers
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('X-Frame-Options', 'SAMEORIGIN');
    if (isSecureRequest(c, config)) {
      c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
  });

  // Health & Readiness endpoints (no secrets exposed)
  app.get('/healthz', (c) => (
    c.json({
      status: 'ok',
      service: 'telegram-web-z-mcp',
      version: serverVersion,
      runtimeMode: runtime.mode,
      timestamp: Date.now(),
    })
  ));

  app.get('/readyz', (c) => (
    c.json({
      status: 'ready',
      linkedAccountsCount: vault.listAccounts(config.ownerId).length,
      runtimeMode: runtime.mode,
    })
  ));

  // Streamable HTTP MCP endpoint (/mcp) with strict HTTPS/Origin/Bearer authentication
  app.all('/mcp', async (c) => {
    if (config.requireHttps && !isSecureRequest(c, config)) {
      return c.json(
        { error: 'HTTPS is required for MCP Streamable HTTP access.' },
        403,
      );
    }

    const origin = c.req.header('origin');
    if (origin && !isOriginAllowed(origin, config, c.req.url)) {
      await vault.appendAudit({
        actor: 'mcp',
        action: 'mcp.origin.rejected',
        status: 'denied',
        detail: `Disallowed Origin: ${origin}`,
      });
      return c.json({ error: 'Forbidden Origin header' }, 403);
    }

    const bearer = extractBearerToken(c.req.header('authorization'));
    const validHashes = vault.getValidMcpTokenHashes();
    if (!verifyTokenAgainstHashes(bearer, validHashes)) {
      await vault.appendAudit({
        actor: 'mcp',
        action: 'mcp.auth.failed',
        status: 'denied',
        detail: 'Missing or invalid Bearer token',
      });
      c.header('WWW-Authenticate', 'Bearer realm="telegram-web-z-mcp", error="invalid_token"');
      return c.json({ error: 'Unauthorized: valid Bearer token required' }, 401);
    }

    c.header('Cache-Control', 'no-store');
    c.header('X-Accel-Buffering', 'no');
    return mcpHandler.fetch(c.req.raw);
  });

  // Admin Console Authentication endpoints
  app.post('/api/auth/login', async (c) => {
    c.header('Cache-Control', 'no-store');
    const body = await readValidatedJson(c, LOGIN_BODY_SCHEMA);
    if (!body) {
      return c.json({ error: 'طلب غير صالح' }, 400);
    }

    if (!verifyTokenAgainstHashes(body.token, [adminTokenHash])) {
      await vault.appendAudit({
        actor: 'admin',
        action: 'admin.login.failed',
        status: 'denied',
        detail: 'Invalid admin token attempt',
      });
      return c.json({ error: 'رمز الدخول الإداري غير صحيح' }, 401);
    }

    const csrfToken = generateStrongToken(24);
    const cookieVal = createSignedSessionCookie(
      { ownerId: config.ownerId, issuedAt: Date.now(), csrfToken },
      cookieSigningKey,
    );

    setCookie(c, ADMIN_COOKIE_NAME, cookieVal, {
      httpOnly: true,
      sameSite: 'Strict',
      secure: isSecureRequest(c, config),
      path: '/',
      maxAge: Math.floor(ADMIN_SESSION_MAX_AGE_MS / 1000),
    });

    await vault.appendAudit({
      actor: 'admin',
      action: 'admin.login.success',
      status: 'ok',
    });

    return c.json({
      authenticated: true,
      csrfToken,
      ownerId: config.ownerId,
      runtimeMode: runtime.mode,
    });
  });

  app.post('/api/auth/logout', async (c) => {
    deleteCookie(c, ADMIN_COOKIE_NAME, { path: '/' });
    return c.json({ authenticated: false });
  });

  app.get('/api/auth/me', (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = resolveAdminAuth(c, config, cookieSigningKey, adminTokenHash);
    if (!auth) {
      return c.json({ authenticated: false }, 200);
    }
    return c.json({
      authenticated: true,
      csrfToken: auth.csrfToken,
      ownerId: auth.ownerId,
      runtimeMode: runtime.mode,
    });
  });

  // Protect all remaining /api/* routes with Admin Auth + CSRF check on mutating requests
  const requireAdminMiddleware = async (c: Context, next: Next) => {
    c.header('Cache-Control', 'no-store');
    if (config.requireHttps && !isSecureRequest(c, config)) {
      return c.json({ error: 'HTTPS is required' }, 403);
    }

    const auth = resolveAdminAuth(c, config, cookieSigningKey, adminTokenHash);
    if (!auth) {
      return c.json({ error: 'غير مصرح — يرجى تسجيل الدخول إلى لوحة الإدارة أولاً' }, 401);
    }

    const method = c.req.method.toUpperCase();
    if (auth.viaCookie && method !== 'GET' && method !== 'HEAD') {
      const providedCsrf = c.req.header('x-csrf-token');
      if (!verifyConstantTimeString(providedCsrf, auth.csrfToken)) {
        return c.json({ error: 'رمز الحماية CSRF غير صالح' }, 403);
      }
    }

    c.set('adminOwnerId' as never, auth.ownerId as never);
    await next();
    return undefined;
  };

  app.use('/api/accounts/*', requireAdminMiddleware);
  app.use('/api/accounts', requireAdminMiddleware);
  app.use('/api/agents/*', requireAdminMiddleware);
  app.use('/api/agents', requireAdminMiddleware);
  app.use('/api/approvals/*', requireAdminMiddleware);
  app.use('/api/approvals', requireAdminMiddleware);
  app.use('/api/mcp/*', requireAdminMiddleware);
  app.use('/api/audit', requireAdminMiddleware);

  app.get('/api/agents', (c) => c.json({ agents: vault.listAgents() }));

  app.get('/api/agents/provider', (c) => c.json(vault.getOpenRouterSettings()));
  app.post('/api/agents/provider', async (c) => {
    const body = await readValidatedJson(c, OPENROUTER_KEY_BODY_SCHEMA);
    if (!body) return c.json({ error: 'مفتاح OpenRouter غير صالح' }, 400);
    await vault.setOpenRouterApiKey(body.apiKey);
    return c.json(vault.getOpenRouterSettings());
  });
  app.delete('/api/agents/provider', async (c) => {
    await vault.clearOpenRouterApiKey();
    return c.json(vault.getOpenRouterSettings());
  });

  app.post('/api/agents/models', async (c) => {
    const body = await readValidatedJson(c, OPENROUTER_MODELS_BODY_SCHEMA);
    if (!body) return c.json({ error: 'بيانات تحميل نماذج OpenRouter غير صالحة' }, 400);
    const apiKey = vault.getOpenRouterApiKey();
    if (!apiKey) return c.json({ error: 'أدخل مفتاح OpenRouter أولاً لتحميل النماذج' }, 400);
    try {
      const response = await fetch(OPENROUTER_MODELS_URL, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return c.json({ error: `تعذر تحميل نماذج OpenRouter (HTTP ${response.status})` }, 502);
      const result = await response.json() as { data?: { id?: string; name?: string; context_length?: number; supported_parameters?: string[] }[] };
      const models = (result.data || [])
        .filter((model) => model.id && model.name)
        .map((model) => ({ id: model.id!, name: model.name!, contextLength: model.context_length }))
        .slice(0, 100);
      return c.json({ models });
    } catch {
      return c.json({ error: 'تعذر الاتصال بـ OpenRouter لتحميل النماذج' }, 502);
    }
  });

  app.post('/api/agents', async (c) => {
    const body = await readValidatedJson(c, AGENT_BODY_SCHEMA);
    if (!body || !vault.getAuthorizedAccount(config.ownerId, body.accountId)) {
      return c.json({ error: 'إعدادات الوكيل غير صالحة أو الحساب غير موجود' }, 400);
    }
    const agent = await vault.upsertAgent(body);
    if (agent.isEnabled) {
      const account = vault.getAuthorizedAccount(config.ownerId, agent.accountId);
      if (account) await runtime.getAccountStatus(account);
    }
    return c.json({ agent }, body.id ? 200 : 201);
  });

  app.delete('/api/agents/:agentId', async (c) => {
    const deleted = await vault.deleteAgent(c.req.param('agentId'));
    return deleted ? c.json({ deleted: true }) : c.json({ error: 'الوكيل غير موجود' }, 404);
  });

  // Accounts API
  app.get('/api/accounts', (c) => {
    const accounts = vault.listAccounts(config.ownerId);
    return c.json({
      accounts,
      runtimeMode: runtime.mode,
      disclaimer: 'عميل غير رسمي مبني على Telegram Web Z — لا يتبع رسمياً لشركة Telegram.',
    });
  });

  app.post('/api/accounts/import-session', async (c) => {
    const body = await readValidatedJson(c, IMPORT_SESSION_BODY_SCHEMA);
    if (!body) {
      return c.json({ error: 'صيغة طلب ربط الجلسة غير صالحة' }, 400);
    }

    try {
      const summary = await vault.upsertAccountFromBridge(config.ownerId, body.payload, body.label);
      return c.json({
        account: summary,
        notice: 'تم تشفير الجلسة وحفظها على الخادم باستخدام AES-256-GCM ومفتاح منفصل. لم يتم تسجيل أي مفاتيح في السجلات.',
      }, 201);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'فشل التحقق من الجلسة';
      return c.json({ error: message }, 400);
    }
  });

  app.get('/api/accounts/:accountId/status', async (c) => {
    const accountId = c.req.param('accountId');
    const account = vault.getAuthorizedAccount(config.ownerId, accountId);
    if (!account) {
      return c.json({ error: 'الحساب غير موجود أو غير مصرح به' }, 404);
    }

    const status = await runtime.getAccountStatus(account);
    return c.json({ status });
  });

  app.delete('/api/accounts/:accountId', async (c) => {
    const accountId = c.req.param('accountId');
    await runtime.disconnectAccount(accountId);
    const removed = await vault.deleteAccount(config.ownerId, accountId);
    if (!removed) {
      return c.json({ error: 'الحساب غير موجود أو غير مصرح به' }, 404);
    }

    return c.json({
      deleted: true,
      accountId,
      revocationNotice: 'تم حذف النسخة المحلية المشفرة من الخادم فقط. هذا لا ينهي الجلسة على خوادم Telegram؛ لإبطالها افتح إعدادات Telegram ← الأجهزة.',
    });
  });

  // Dialogs & Messages API
  app.get('/api/accounts/:accountId/dialogs', async (c) => {
    const account = vault.getAuthorizedAccount(config.ownerId, c.req.param('accountId'));
    if (!account) return c.json({ error: 'الحساب غير موجود' }, 404);

    const limit = clampInt(c.req.query('limit'), 30, 1, 100);
    const archived = c.req.query('archived') === 'true';

    try {
      const dialogs = await runtime.listDialogs(account, { limit, archived });
      return c.json({ dialogs });
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : 'تعذر جلب المحادثات' }, 502);
    }
  });

  app.get('/api/accounts/:accountId/messages', async (c) => {
    const account = vault.getAuthorizedAccount(config.ownerId, c.req.param('accountId'));
    if (!account) return c.json({ error: 'الحساب غير موجود' }, 404);

    const chatId = c.req.query('chatId');
    if (!chatId || !/^-?\d+$/.test(chatId)) {
      return c.json({ error: 'معرّف المحادثة chatId مطلوب وبصيغة رقمية صحيحة' }, 400);
    }
    const limit = clampInt(c.req.query('limit'), 30, 1, 100);
    const offsetId = c.req.query('offsetId') ? clampInt(c.req.query('offsetId'), 0, 0, 2_000_000_000) : undefined;

    try {
      const messages = await runtime.readMessages(account, { chatId, limit, offsetId });
      return c.json({ messages });
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : 'تعذر قراءة الرسائل' }, 502);
    }
  });

  app.get('/api/accounts/:accountId/search', async (c) => {
    const account = vault.getAuthorizedAccount(config.ownerId, c.req.param('accountId'));
    if (!account) return c.json({ error: 'الحساب غير موجود' }, 404);

    const query = (c.req.query('q') || '').trim();
    if (!query || query.length > 256) {
      return c.json({ error: 'عبارة البحث مطلوبة (1 إلى 256 حرفاً)' }, 400);
    }
    const chatId = c.req.query('chatId')?.trim() || undefined;
    if (chatId && !/^-?\d+$/.test(chatId)) {
      return c.json({ error: 'معرّف المحادثة غير صالح' }, 400);
    }
    const limit = clampInt(c.req.query('limit'), 20, 1, 50);

    try {
      const messages = await runtime.searchMessages(account, { query, chatId, limit });
      return c.json({ messages });
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : 'تعذر البحث في الرسائل' }, 502);
    }
  });

  app.post('/api/accounts/:accountId/send', async (c) => {
    const accountId = c.req.param('accountId');
    const account = vault.getAuthorizedAccount(config.ownerId, accountId);
    if (!account) return c.json({ error: 'الحساب غير موجود' }, 404);

    const body = await readValidatedJson(c, SEND_MESSAGE_BODY_SCHEMA);
    if (!body) {
      return c.json({ error: 'بيانات الإرسال غير مكتملة أو غير صالحة' }, 400);
    }

    if (body.confirmedTargetAccountId !== account.id || body.confirmedTargetChatId !== body.chatId) {
      return c.json({ error: 'يلزم تأكيد الحساب والمحادثة المستهدفين بدقة قبل الإرسال' }, 400);
    }

    try {
      const sent = await runtime.sendMessage(account, {
        chatId: body.chatId,
        text: body.text,
        replyToMsgId: body.replyToMsgId,
      });
      await vault.appendAudit({
        actor: 'admin',
        action: 'ui.send_message',
        accountId: account.id,
        target: body.chatId,
        status: 'ok',
        detail: `Sent message #${sent.messageId} after explicit UI confirmation`,
      });
      return c.json({ sent });
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : 'تعذر إرسال الرسالة' }, 502);
    }
  });

  // Approvals API (for MCP write actions)
  app.get('/api/approvals', (c) => {
    const items = approvals.listForOwner(config.ownerId);
    return c.json({ approvals: items });
  });

  app.post('/api/approvals/:id/approve', async (c) => {
    const approvalId = c.req.param('id');
    const body = (await readValidatedJson(c, APPROVE_BODY_SCHEMA)) || { executeNow: true };

    try {
      const approved = approvals.approve(config.ownerId, approvalId);

      if (!body.executeNow) {
        await vault.appendAudit({
          actor: 'admin',
          action: `approval.approved.${approved.action}`,
          accountId: approved.accountId,
          target: approved.targetLabel,
          status: 'ok',
          detail: `Approved ${approved.id} for agent execution`,
        });
        return c.json({ approval: approved });
      }

      const account = vault.getAuthorizedAccount(config.ownerId, approved.accountId);
      if (!account) {
        approvals.markExecuted(config.ownerId, approved.id, undefined, 'Account no longer linked');
        return c.json({ error: 'الحساب المرتبط بهذا الطلب لم يعد متصلاً' }, 404);
      }

      approvals.consumeApprovedForExecution({
        ownerId: config.ownerId,
        approvalId: approved.id,
        accountId: approved.accountId,
        action: approved.action,
        payload: approved.payload,
      });

      const executionResult = await executeApprovedAction(runtime, account, approved.action, approved.payload);
      const updated = approvals.markExecuted(config.ownerId, approved.id, executionResult);

      await vault.appendAudit({
        actor: 'admin',
        action: `approval.executed.${approved.action}`,
        accountId: approved.accountId,
        target: approved.targetLabel,
        status: 'ok',
        detail: `Approved and executed ${approved.id}`,
      });

      return c.json({ approval: updated, result: executionResult });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'تعذر اعتماد الطلب';
      return c.json({ error: message }, 400);
    }
  });

  app.post('/api/approvals/:id/reject', async (c) => {
    const approvalId = c.req.param('id');
    const body = (await readValidatedJson(c, REJECT_BODY_SCHEMA)) || {};
    try {
      const rejected = approvals.reject(config.ownerId, approvalId, body.reason);
      await vault.appendAudit({
        actor: 'admin',
        action: `approval.rejected.${rejected.action}`,
        accountId: rejected.accountId,
        target: rejected.targetLabel,
        status: 'denied',
        detail: body.reason || 'Rejected by user',
      });
      return c.json({ approval: rejected });
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : 'تعذر رفض الطلب' }, 400);
    }
  });

  // MCP Settings & Token Rotation API
  app.get('/api/mcp/settings', (c) => {
    const requestOrigin = resolvePublicOrigin(c, config);
    const tokenMeta = vault.getMcpTokenMetadata();
    return c.json({
      endpointUrl: `${requestOrigin}/mcp`,
      transport: 'Streamable HTTP (MCP 2025-11-25 & 2026-07-28)',
      authScheme: 'Bearer Token (قابل للتدوير)',
      httpsEnforced: config.requireHttps,
      runtimeMode: runtime.mode,
      allowedOrigins: config.mcpAllowedOrigins,
      hasPreviousToken: tokenMeta.hasPreviousToken,
      rotatedAt: tokenMeta.rotatedAt,
      tools: MCP_TOOL_CATALOG,
    });
  });

  app.post('/api/mcp/rotate-token', async (c) => {
    const body = (await readValidatedJson(c, ROTATE_TOKEN_BODY_SCHEMA)) || { keepPrevious: true };
    const rotated = await vault.rotateMcpToken(body.keepPrevious);
    return c.json({
      newToken: rotated.token,
      rotatedAt: rotated.rotatedAt,
      keepPrevious: body.keepPrevious,
      warning: 'يُعرض هذا الرمز مرة واحدة فقط. احفظه في إعدادات وكيل الذكاء الاصطناعي فوراً ولن يُخزّن بنص صريح على الخادم.',
    });
  });

  app.get('/api/audit', (c) => {
    const limit = clampInt(c.req.query('limit'), 50, 1, 200);
    return c.json({ entries: vault.getAuditLog(limit) });
  });

  // Static serving for HeroUI Management Console (/console and /console/*)
  app.get('/console', (c) => c.redirect('/console/', 302));
  app.get('/console/*', async (c) => {
    const relativePath = c.req.path.replace(/^\/console\/?/, '') || 'index.html';
    const served = await tryServeStaticFile(config.consoleDistDir, relativePath, 'index.html');
    if (served) return served;
    return c.text('Management console build not found. Run `npm run build:console`.', 404);
  });

  // Static serving for Telegram Web Z (/*)
  app.get('*', async (c) => {
    const relativePath = c.req.path.replace(/^\//, '') || 'index.html';
    const served = await tryServeStaticFile(config.distDir, relativePath, 'index.html');
    if (served) return served;
    return c.text('Telegram Web Z build not found. Run `npm run build:production`.', 404);
  });

  return { app, mcpHandler };
}

async function executeApprovedAction(
  runtime: TelegramAccountRuntime,
  account: NonNullable<ReturnType<EncryptedSessionVault['getAuthorizedAccount']>>,
  action: 'send_message' | 'create_group' | 'create_channel' | 'mark_chat_read',
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (action) {
    case 'send_message':
      return runtime.sendMessage(account, {
        chatId: String(payload.chatId),
        text: String(payload.text),
        replyToMsgId: typeof payload.replyToMsgId === 'number' ? payload.replyToMsgId : undefined,
      });
    case 'create_group':
      return runtime.createGroup(account, {
        title: String(payload.title),
        userIds: Array.isArray(payload.userIds) ? payload.userIds.map(String) : [],
      });
    case 'create_channel':
      return runtime.createChannel(account, {
        title: String(payload.title),
        about: typeof payload.about === 'string' ? payload.about : '',
        isMegagroup: Boolean(payload.isMegagroup),
      });
    case 'mark_chat_read':
      return runtime.markChatRead(account, {
        chatId: String(payload.chatId),
        maxId: typeof payload.maxId === 'number' ? payload.maxId : undefined,
      });
  }
}

function resolveAdminAuth(
  c: Context,
  config: ServerConfig,
  cookieSigningKey: Buffer,
  adminTokenHash: string,
): { ownerId: string; csrfToken?: string; viaCookie: boolean } | undefined {
  const bearer = extractBearerToken(c.req.header('authorization'));
  if (bearer && verifyTokenAgainstHashes(bearer, [adminTokenHash])) {
    return { ownerId: config.ownerId, viaCookie: false };
  }

  const rawCookie = getCookie(c, ADMIN_COOKIE_NAME);
  const parsed = verifySignedSessionCookie(rawCookie, cookieSigningKey, ADMIN_SESSION_MAX_AGE_MS);
  if (parsed && parsed.ownerId === config.ownerId) {
    return { ownerId: parsed.ownerId, csrfToken: parsed.csrfToken, viaCookie: true };
  }

  return undefined;
}

function extractBearerToken(header?: string): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

function isSecureRequest(c: Context, config: ServerConfig): boolean {
  if (config.trustProxy) {
    const forwardedProto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
    if (forwardedProto === 'https') return true;
  }
  try {
    return new URL(c.req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

function resolvePublicOrigin(c: Context, config: ServerConfig): string {
  if (config.publicOrigin) return config.publicOrigin.replace(/\/+$/, '');
  const proto = isSecureRequest(c, config) ? 'https' : 'http';
  const host = c.req.header('x-forwarded-host') || c.req.header('host') || `127.0.0.1:${config.port}`;
  return `${proto}://${host}`;
}

function isOriginAllowed(origin: string, config: ServerConfig, requestUrl: string): boolean {
  try {
    const parsedOrigin = new URL(origin);
    const normalized = parsedOrigin.origin;

    if (config.mcpAllowedOrigins.includes(normalized)) {
      return true;
    }

    const requestOrigin = new URL(requestUrl).origin;
    if (normalized === requestOrigin) {
      return true;
    }

    if (!config.isProduction && (
      parsedOrigin.hostname === 'localhost'
      || parsedOrigin.hostname === '127.0.0.1'
      || parsedOrigin.hostname === '[::1]'
    )) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

async function readValidatedJson<T>(c: Context, schema: z.ZodType<T>): Promise<T | undefined> {
  const contentLength = Number(c.req.header('content-length') || 0);
  if (contentLength > MAX_JSON_BODY_BYTES) return undefined;

  try {
    const rawText = await c.req.text();
    if (Buffer.byteLength(rawText, 'utf8') > MAX_JSON_BODY_BYTES) return undefined;
    const parsed = JSON.parse(rawText);
    const result = schema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function buildAgentSystemPrompt(persona: AgentPersona | undefined, systemPrompt: string): string {
  if (!persona) return systemPrompt;

  const identity = [
    persona.name && `الاسم: ${persona.name}`,
    persona.role && `الدور: ${persona.role}`,
    persona.region && `المنطقة: ${persona.region}`,
    persona.dialect && `اللهجة: ${persona.dialect}`,
    persona.ageStyle && `الطابع العمري للصوت: ${persona.ageStyle}`,
    persona.tone && `النبرة: ${persona.tone}`,
    persona.formality && `طريقة الكلام: ${persona.formality}`,
  ].filter((item): item is string => Boolean(item));

  if (!identity.length) return systemPrompt;

  return [
    'هوية الوكيل وأسلوبه:',
    ...identity,
    'اكتب بطريقة طبيعية وعفوية تناسب محادثة مجموعة، وتجنب الصياغات الآلية والتعدادات غير اللازمة. لا تختلق عمراً أو تجارب شخصية واقعية. إذا سُئلت مباشرة عن طبيعتك، أجب بصدق وباختصار.',
    '',
    'تعليمات المجموعة:',
    systemPrompt,
  ].join('\n');
}

async function tryServeStaticFile(
  rootDir: string,
  relativePath: string,
  spaFallback?: string,
): Promise<Response | undefined> {
  const normalizedRoot = resolve(rootDir);
  const candidate = resolve(normalizedRoot, relativePath);
  if (!candidate.startsWith(normalizedRoot)) {
    return new Response('Forbidden', { status: 403 });
  }

  const direct = await readStaticFileIfExists(candidate);
  if (direct) return direct;

  if (spaFallback && !extname(relativePath)) {
    const fallbackFile = resolve(normalizedRoot, spaFallback);
    return readStaticFileIfExists(fallbackFile);
  }

  return undefined;
}

async function readStaticFileIfExists(filePath: string): Promise<Response | undefined> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return undefined;
    const buffer = await readFile(filePath);
    const contentType = MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return undefined;
  }
}
