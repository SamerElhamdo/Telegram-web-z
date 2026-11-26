import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';

import { ApprovalStore } from './approvals/approvalStore';
import { loadServerConfig } from './config';
import { createServerApp } from './http/createApp';
import { EncryptedSessionVault } from './storage/sessionVault';
import { GramJsTelegramAccountRuntime } from './telegram/gramjsRuntime';
import { MockTelegramAccountRuntime } from './telegram/mockRuntime';

async function main() {
  const config = loadServerConfig();
  const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { version?: string };
  const serverVersion = packageJson.version || '1.0.0';

  const vault = new EncryptedSessionVault({
    dataDir: config.dataDir,
    encryptionSecret: config.sessionEncryptionKey,
    initialMcpToken: config.mcpAuthToken,
    previousMcpToken: config.mcpAuthTokenPrevious,
  });
  await vault.init();

  const approvals = new ApprovalStore();
  const runtime = config.telegramRuntimeMode === 'mock'
    ? new MockTelegramAccountRuntime()
    : new GramJsTelegramAccountRuntime({
      apiId: config.telegramApiId,
      apiHash: config.telegramApiHash,
    });

  const { app, mcpHandler } = createServerApp({
    config,
    vault,
    approvals,
    runtime,
    serverVersion,
  });

  for (const agent of vault.listAgents().filter((item) => item.isEnabled)) {
    const account = vault.getAuthorizedAccount(config.ownerId, agent.accountId);
    if (account) await runtime.getAccountStatus(account);
  }

  const server = serve({
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  }, (info) => {
    // Never log secrets, session keys, API hashes, or auth tokens
    process.stdout.write(
      `[telegram-web-z-mcp] Listening on http://${info.address}:${info.port} (mode=${runtime.mode}, env=${config.nodeEnv})\n`,
    );
    process.stdout.write(
      `[telegram-web-z-mcp] Endpoints: / (Web Z), /console/ (HeroUI Admin), /mcp (Streamable HTTP MCP), /healthz\n`,
    );
  });

  const shutdown = async () => {
    await mcpHandler.close();
    await runtime.shutdown();
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : 'Fatal server startup error';
  process.stderr.write(`[telegram-web-z-mcp] Startup failed: ${message}\n`);
  process.exit(1);
});
