import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildBridgePayloadFromWebZSlot } from '../../src/shared/sessionBridge';
import { ApprovalStore } from '../approvals/approvalStore';
import { loadServerConfig } from '../config';
import { createServerApp } from '../http/createApp';
import { EncryptedSessionVault } from '../storage/sessionVault';
import { MockTelegramAccountRuntime } from '../telegram/mockRuntime';

const DUMMY_KEY_DC2 = 'd4'.repeat(256); // 512 hex chars synthetic key
const TEST_ENCRYPTION_KEY = 'f'.repeat(64);
const TEST_ADMIN_TOKEN = 'test-admin-secret-token-0123456789abcdef';
const TEST_MCP_TOKEN = 'test-mcp-bearer-token-0123456789abcdef';

describe('EncryptedSessionVault + Streamable HTTP MCP Security & Approvals', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tg-webz-mcp-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function setupTestHarness(overrides: Partial<NodeJS.ProcessEnv> = {}) {
    const config = loadServerConfig({
      NODE_ENV: 'test',
      DATA_DIR: tempDir,
      TELEGRAM_RUNTIME_MODE: 'mock',
      SESSION_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
      ADMIN_AUTH_TOKEN: TEST_ADMIN_TOKEN,
      MCP_AUTH_TOKEN: TEST_MCP_TOKEN,
      MCP_ALLOWED_ORIGINS: 'https://allowed.example.com',
      TRUST_PROXY: 'true',
      REQUIRE_HTTPS: 'true',
      ...overrides,
    });

    const vault = new EncryptedSessionVault({
      dataDir: config.dataDir,
      encryptionSecret: config.sessionEncryptionKey,
      initialMcpToken: config.mcpAuthToken,
    });
    await vault.init();

    const approvals = new ApprovalStore();
    const runtime = new MockTelegramAccountRuntime();
    const { app, mcpHandler } = createServerApp({
      config,
      vault,
      approvals,
      runtime,
      serverVersion: '13.0.1-test',
    });

    const payload = buildBridgePayloadFromWebZSlot(1, {
      dcId: 2,
      dc2_auth_key: DUMMY_KEY_DC2,
      userId: '880011',
      firstName: 'مستخدم تجريبي',
      phone: '+966501112233',
    });
    const linkedAccount = await vault.upsertAccountFromBridge(config.ownerId, payload, 'حساب الاختبار');

    return { config, vault, approvals, runtime, app, mcpHandler, linkedAccount };
  }

  it('encrypts sessions at rest with AES-256-GCM, restricts permissions, and enforces owner isolation', async () => {
    const { vault, linkedAccount } = await setupTestHarness();

    const rawFile = await readFile(vault.getVaultPath(), 'utf8');
    expect(rawFile).not.toContain(DUMMY_KEY_DC2);
    expect(rawFile).not.toContain('880011');
    expect(rawFile).toContain('"alg": "aes-256-gcm"');

    const fileStats = await stat(vault.getVaultPath());
    expect(fileStats.mode & 0o777).toBe(0o600);

    // Owner isolation check
    expect(vault.getAuthorizedAccount('primary-owner', linkedAccount.id)).toBeDefined();
    expect(vault.getAuthorizedAccount('other-unauthorized-owner', linkedAccount.id)).toBeUndefined();

    // Wrong key must fail to unlock vault
    const badVault = new EncryptedSessionVault({
      dataDir: tempDir,
      encryptionSecret: '0'.repeat(64),
      initialMcpToken: TEST_MCP_TOKEN,
    });
    await expect(badVault.init()).rejects.toThrow(/Failed to unlock encrypted session vault/);
  });

  it('rejects unauthenticated, invalid-token, non-HTTPS, and disallowed-Origin MCP requests', async () => {
    const { app, mcpHandler } = await setupTestHarness();

    try {
      // 1. Plain HTTP rejected when REQUIRE_HTTPS=true
      const httpRes = await app.request('http://tg.example.com/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${TEST_MCP_TOKEN}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(httpRes.status).toBe(403);

      // 2. Missing Bearer token -> 401 + WWW-Authenticate
      const noAuthRes = await app.request('https://tg.example.com/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(noAuthRes.status).toBe(401);
      expect(noAuthRes.headers.get('www-authenticate')).toContain('Bearer');

      // 3. Invalid Bearer token -> 401
      const badAuthRes = await app.request('https://tg.example.com/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer wrong-token-value',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(badAuthRes.status).toBe(401);

      // 4. Disallowed Origin -> 403 (DNS rebinding guard)
      const badOriginRes = await app.request('https://tg.example.com/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${TEST_MCP_TOKEN}`,
          Origin: 'https://evil.attacker.invalid',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(badOriginRes.status).toBe(403);
    } finally {
      await mcpHandler.close();
    }
  });

  it('serves Streamable HTTP MCP read tools safely and blocks reading unauthorized accounts', async () => {
    const { app, mcpHandler, linkedAccount } = await setupTestHarness();

    async function callMcp(body: Record<string, unknown>, token = TEST_MCP_TOKEN) {
      const res = await app.request('https://tg.example.com/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${token}`,
          Origin: 'https://allowed.example.com',
        },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      return parseMcpHttpResponse(res);
    }

    try {
      const listTools = await callMcp({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      });
      const toolNames = (listTools.result.tools as Array<{ name: string }>).map((t) => t.name);
      expect(toolNames).toEqual(expect.arrayContaining([
        'list_accounts',
        'list_dialogs',
        'read_messages',
        'search_messages',
        'send_message',
        'create_group',
        'create_channel',
        'mark_chat_read',
      ]));

      // list_accounts must NEVER expose auth keys
      const accountsRes = await callMcp({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'list_accounts', arguments: {} },
      });
      const accountsText = extractToolText(accountsRes);
      expect(accountsText).toContain(linkedAccount.id);
      expect(accountsText).not.toContain(DUMMY_KEY_DC2);

      // list_dialogs on authorized account
      const dialogsRes = await callMcp({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'list_dialogs',
          arguments: { accountId: linkedAccount.id, limit: 10 },
        },
      });
      expect(extractToolText(dialogsRes)).toContain('777000');

      // Unauthorized / unknown accountId must be rejected
      const deniedRes = await callMcp({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'read_messages',
          arguments: { accountId: 'acc_other_user_999', chatId: '777000', limit: 5 },
        },
      });
      expect(deniedRes.result.isError).toBe(true);
    } finally {
      await mcpHandler.close();
    }
  });

  it('requires explicit user approval before executing MCP write tools and prevents replay/tampering', async () => {
    const { app, mcpHandler, linkedAccount } = await setupTestHarness();

    async function callMcpTool(id: number, name: string, args: Record<string, unknown>) {
      const res = await app.request('https://tg.example.com/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${TEST_MCP_TOKEN}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      expect(res.status).toBe(200);
      return parseMcpHttpResponse(res);
    }

    try {
      // 1. Calling send_message without approval returns approval_required (does NOT send!)
      const pendingRes = await callMcpTool(10, 'send_message', {
        accountId: linkedAccount.id,
        chatId: '777000',
        text: 'رسالة اختبار محاكاة',
      });
      const pendingJson = JSON.parse(extractToolText(pendingRes)) as { status: string; approvalId: string };
      expect(pendingJson.status).toBe('approval_required');
      expect(pendingJson.approvalId).toMatch(/^apr_/);

      // 2. Trying to execute before user approves fails
      const unapprovedAttempt = await callMcpTool(11, 'send_message', {
        accountId: linkedAccount.id,
        chatId: '777000',
        text: 'رسالة اختبار محاكاة',
        approvalId: pendingJson.approvalId,
      });
      expect(unapprovedAttempt.result.isError).toBe(true);

      // 3. Approve via Admin API (with executeNow: false so agent executes with approvalId)
      const approveRes = await app.request(`https://tg.example.com/api/approvals/${pendingJson.approvalId}/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
        },
        body: JSON.stringify({ executeNow: false }),
      });
      expect(approveRes.status).toBe(200);

      // 4. Tampered message text with same approvalId MUST fail
      const tamperedAttempt = await callMcpTool(12, 'send_message', {
        accountId: linkedAccount.id,
        chatId: '777000',
        text: 'نص مختلف تم تغييره بعد الموافقة',
        approvalId: pendingJson.approvalId,
      });
      expect(tamperedAttempt.result.isError).toBe(true);

      // 5. Exact approved payload executes once
      const executedRes = await callMcpTool(13, 'send_message', {
        accountId: linkedAccount.id,
        chatId: '777000',
        text: 'رسالة اختبار محاكاة',
        approvalId: pendingJson.approvalId,
      });
      const executedJson = JSON.parse(extractToolText(executedRes)) as { status: string; result: { messageId: number } };
      expect(executedJson.status).toBe('executed');
      expect(executedJson.result.messageId).toBeGreaterThan(0);

      // 6. Replaying same approvalId MUST fail (single-use)
      const replayAttempt = await callMcpTool(14, 'send_message', {
        accountId: linkedAccount.id,
        chatId: '777000',
        text: 'رسالة اختبار محاكاة',
        approvalId: pendingJson.approvalId,
      });
      expect(replayAttempt.result.isError).toBe(true);
    } finally {
      await mcpHandler.close();
    }
  });

  it('enforces admin cookie + CSRF protection and supports Bearer token rotation', async () => {
    const { app, mcpHandler } = await setupTestHarness();

    try {
      // Unauthenticated Admin API rejected
      const unauthAdmin = await app.request('https://tg.example.com/api/accounts');
      expect(unauthAdmin.status).toBe(401);

      // Admin login returns HttpOnly cookie + csrfToken
      const loginRes = await app.request('https://tg.example.com/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: TEST_ADMIN_TOKEN }),
      });
      expect(loginRes.status).toBe(200);
      const setCookieHeader = loginRes.headers.get('set-cookie') || '';
      expect(setCookieHeader).toContain('HttpOnly');
      expect(setCookieHeader).toContain('SameSite=Strict');
      const cookiePair = setCookieHeader.split(';')[0];
      const loginJson = (await loginRes.json()) as { csrfToken: string };

      // Mutating request with cookie but WITHOUT CSRF header -> 403
      const missingCsrfRes = await app.request('https://tg.example.com/api/mcp/rotate-token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookiePair,
        },
        body: JSON.stringify({ keepPrevious: false }),
      });
      expect(missingCsrfRes.status).toBe(403);

      // Mutating request WITH valid CSRF rotates MCP token and revokes old one
      const rotateRes = await app.request('https://tg.example.com/api/mcp/rotate-token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookiePair,
          'X-CSRF-Token': loginJson.csrfToken,
        },
        body: JSON.stringify({ keepPrevious: false }),
      });
      expect(rotateRes.status).toBe(200);
      const { newToken } = (await rotateRes.json()) as { newToken: string };
      expect(newToken.length).toBeGreaterThan(20);

      // Old token is now rejected with 401
      const oldTokenRes = await app.request('https://tg.example.com/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${TEST_MCP_TOKEN}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(oldTokenRes.status).toBe(401);

      // New rotated token works immediately
      const newTokenRes = await app.request('https://tg.example.com/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${newToken}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      expect(newTokenRes.status).toBe(200);
    } finally {
      await mcpHandler.close();
    }
  });
});

async function parseMcpHttpResponse(res: Response): Promise<{ result: Record<string, unknown> }> {
  const contentType = res.headers.get('content-type') || '';
  const body = await res.text();
  if (contentType.includes('text/event-stream')) {
    const dataLines = body
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    const lastPayload = dataLines[dataLines.length - 1];
    return JSON.parse(lastPayload) as { result: Record<string, unknown> };
  }
  return JSON.parse(body) as { result: Record<string, unknown> };
}

function extractToolText(rpcResponse: { result: Record<string, unknown> }): string {
  const content = rpcResponse.result.content as Array<{ type: string; text?: string }>;
  return content?.[0]?.text || '';
}
