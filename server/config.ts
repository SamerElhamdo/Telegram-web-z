import { resolve } from 'node:path';

export type TelegramRuntimeMode = 'gramjs' | 'mock';

export type ServerConfig = {
  nodeEnv: string;
  isProduction: boolean;
  host: string;
  port: number;
  dataDir: string;
  publicOrigin?: string;
  trustProxy: boolean;
  requireHttps: boolean;
  telegramApiId: number;
  telegramApiHash: string;
  telegramRuntimeMode: TelegramRuntimeMode;
  sessionEncryptionKey: string;
  adminAuthToken: string;
  mcpAuthToken: string;
  mcpAuthTokenPrevious?: string;
  mcpAllowedOrigins: string[];
  ownerId: string;
  distDir: string;
  consoleDistDir: string;
};

const DEFAULT_PORT = 8787;
const MIN_SECRET_LENGTH = 24;

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';
  const host = env.HOST || (isProduction ? '0.0.0.0' : '127.0.0.1');
  const parsedPort = Number(env.PORT || DEFAULT_PORT);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : DEFAULT_PORT;

  const dataDir = resolve(process.cwd(), env.DATA_DIR || './data');
  const distDir = resolve(process.cwd(), env.WEBZ_DIST_DIR || './dist');
  const consoleDistDir = resolve(process.cwd(), env.CONSOLE_DIST_DIR || './dist/console');

  const telegramApiId = Number(env.TELEGRAM_API_ID || 0);
  const telegramApiHash = (env.TELEGRAM_API_HASH || '').trim();
  const rawMode = (env.TELEGRAM_RUNTIME_MODE || (nodeEnv === 'test' ? 'mock' : 'gramjs')).toLowerCase();
  const telegramRuntimeMode: TelegramRuntimeMode = rawMode === 'mock' ? 'mock' : 'gramjs';

  const sessionEncryptionKey = (env.SESSION_ENCRYPTION_KEY || '').trim();
  const adminAuthToken = (env.ADMIN_AUTH_TOKEN || '').trim();
  const mcpAuthToken = (env.MCP_AUTH_TOKEN || '').trim();
  const mcpAuthTokenPrevious = (env.MCP_AUTH_TOKEN_PREVIOUS || '').trim() || undefined;

  if (isProduction) {
    assertProductionSecret('SESSION_ENCRYPTION_KEY', sessionEncryptionKey);
    assertProductionSecret('ADMIN_AUTH_TOKEN', adminAuthToken);
    assertProductionSecret('MCP_AUTH_TOKEN', mcpAuthToken);
    if (sessionEncryptionKey === telegramApiHash || sessionEncryptionKey === mcpAuthToken) {
      throw new Error('SESSION_ENCRYPTION_KEY must be separate from TELEGRAM_API_HASH and MCP_AUTH_TOKEN');
    }
    if (telegramRuntimeMode === 'gramjs' && (!Number.isInteger(telegramApiId) || telegramApiId <= 0 || !telegramApiHash)) {
      throw new Error('TELEGRAM_API_ID and TELEGRAM_API_HASH are required in production GramJS mode');
    }
  }

  const publicOrigin = env.PUBLIC_ORIGIN?.trim() || undefined;
  const rawAllowedOrigins = (env.MCP_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (publicOrigin && !rawAllowedOrigins.includes(publicOrigin)) {
    rawAllowedOrigins.push(publicOrigin);
  }

  const trustProxy = env.TRUST_PROXY === 'true' || isProduction;
  const requireHttps = env.REQUIRE_HTTPS === 'true' || isProduction;
  const ownerId = (env.ACCOUNT_OWNER_ID || 'primary-owner').trim() || 'primary-owner';

  return {
    nodeEnv,
    isProduction,
    host,
    port,
    dataDir,
    publicOrigin,
    trustProxy,
    requireHttps,
    telegramApiId,
    telegramApiHash,
    telegramRuntimeMode,
    sessionEncryptionKey: sessionEncryptionKey || 'dev-only-insecure-ephemeral-key-do-not-use-in-prod',
    adminAuthToken: adminAuthToken || 'dev-only-admin-token-change-before-deploy',
    mcpAuthToken: mcpAuthToken || 'dev-only-mcp-token-change-before-deploy',
    mcpAuthTokenPrevious,
    mcpAllowedOrigins: rawAllowedOrigins,
    ownerId,
    distDir,
    consoleDistDir,
  };
}

function assertProductionSecret(name: string, value: string) {
  if (!value || value.length < MIN_SECRET_LENGTH) {
    throw new Error(`${name} must be configured with at least ${MIN_SECRET_LENGTH} characters in production`);
  }
}
