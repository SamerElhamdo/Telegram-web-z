import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type {
  BridgeAccountProfile,
  BridgeApiSessionData,
  BridgeSessionPayload,
} from '../../src/shared/sessionBridge';
import type { EncryptedEnvelope } from '../security/crypto';

import {
  getWssEndpointForDc,
  redactSensitiveData,
  validateBridgePayload,
} from '../../src/shared/sessionBridge';
import {
  decryptJson,
  deriveAes256Key,
  encryptJson,
  generateStrongToken,
  hashSecretToken,
} from '../security/crypto';

export type StoredAccountRecord = {
  id: string;
  ownerId: string;
  label: string;
  slot?: number;
  mainDcId: number;
  wssEndpoint: string;
  isTest: boolean;
  profile: BridgeAccountProfile;
  sessionData: BridgeApiSessionData;
  linkedAt: number;
  updatedAt: number;
};

export type PublicAccountSummary = {
  id: string;
  label: string;
  slot?: number;
  mainDcId: number;
  wssEndpoint: string;
  isTest: boolean;
  profile: BridgeAccountProfile;
  linkedAt: number;
  updatedAt: number;
};

export type AuditLogEntry = {
  id: string;
  timestamp: number;
  actor: 'admin' | 'mcp' | 'system';
  action: string;
  accountId?: string;
  target?: string;
  status: 'ok' | 'denied' | 'pending_approval' | 'error';
  detail?: string;
};

export type AgentTool = 'read_group_messages' | 'search_group_messages' | 'reply_to_group';

export type StoredAgentConfig = {
  id: string;
  name: string;
  accountId: string;
  chatId: string;
  providerUrl: string;
  model: string;
  apiKey: string;
  systemPrompt: string;
  tools: AgentTool[];
  isEnabled: boolean;
  updatedAt: number;
};

export type PublicAgentConfig = Omit<StoredAgentConfig, 'apiKey'> & { hasApiKey: boolean };

type VaultDocument = {
  version: 1;
  accounts: Record<string, StoredAccountRecord>;
  mcpTokens: {
    currentHash: string;
    previousHash?: string;
    rotatedAt?: number;
  };
  auditLog: AuditLogEntry[];
  agents: Record<string, StoredAgentConfig>;
};

const MAX_AUDIT_ENTRIES = 200;
const VAULT_FILENAME = 'sessions.vault.enc.json';
const DIR_PERMISSIONS = 0o700;
const FILE_PERMISSIONS = 0o600;

export class EncryptedSessionVault {
  private readonly vaultPath: string;
  private readonly encryptionKey: Buffer;
  private doc: VaultDocument;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: {
    dataDir: string;
    encryptionSecret: string;
    initialMcpToken: string;
    previousMcpToken?: string;
  }) {
    this.vaultPath = join(options.dataDir, VAULT_FILENAME);
    this.encryptionKey = deriveAes256Key(options.encryptionSecret);
    this.doc = {
      version: 1,
      accounts: {},
      mcpTokens: {
        currentHash: hashSecretToken(options.initialMcpToken),
        previousHash: options.previousMcpToken ? hashSecretToken(options.previousMcpToken) : undefined,
      },
      auditLog: [],
      agents: {},
    };
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.vaultPath), { recursive: true, mode: DIR_PERMISSIONS });
    try {
      await chmod(dirname(this.vaultPath), DIR_PERMISSIONS);
    } catch {
      // Ignore chmod failures on filesystems that do not support POSIX modes
    }

    try {
      const raw = await readFile(this.vaultPath, 'utf8');
      const envelope = JSON.parse(raw) as EncryptedEnvelope;
      const decrypted = decryptJson<VaultDocument>(envelope, this.encryptionKey);
      if (decrypted && decrypted.version === 1 && decrypted.accounts) {
        this.doc = {
          version: 1,
          accounts: decrypted.accounts,
          mcpTokens: decrypted.mcpTokens?.currentHash
            ? decrypted.mcpTokens
            : this.doc.mcpTokens,
          auditLog: Array.isArray(decrypted.auditLog) ? decrypted.auditLog.slice(-MAX_AUDIT_ENTRIES) : [],
          agents: decrypted.agents || {},
        };
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        await this.persist();
        return;
      }
      throw new Error('Failed to unlock encrypted session vault (check SESSION_ENCRYPTION_KEY)');
    }
  }

  getVaultPath(): string {
    return this.vaultPath;
  }

  getValidMcpTokenHashes(): string[] {
    const hashes = [this.doc.mcpTokens.currentHash];
    if (this.doc.mcpTokens.previousHash) {
      hashes.push(this.doc.mcpTokens.previousHash);
    }
    return hashes;
  }

  getMcpTokenMetadata(): { hasPreviousToken: boolean; rotatedAt?: number } {
    return {
      hasPreviousToken: Boolean(this.doc.mcpTokens.previousHash),
      rotatedAt: this.doc.mcpTokens.rotatedAt,
    };
  }

  async rotateMcpToken(keepPrevious = true): Promise<{ token: string; rotatedAt: number }> {
    const nextToken = generateStrongToken(32);
    const rotatedAt = Date.now();
    this.doc.mcpTokens = {
      previousHash: keepPrevious ? this.doc.mcpTokens.currentHash : undefined,
      currentHash: hashSecretToken(nextToken),
      rotatedAt,
    };
    await this.appendAudit({
      actor: 'admin',
      action: 'mcp.token.rotate',
      status: 'ok',
      detail: keepPrevious ? 'Rotated with previous token grace period' : 'Rotated and revoked previous token',
    });
    return { token: nextToken, rotatedAt };
  }

  listAccounts(ownerId: string): PublicAccountSummary[] {
    return Object.values(this.doc.accounts)
      .filter((account) => account.ownerId === ownerId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(toPublicAccountSummary);
  }

  listAgents(): PublicAgentConfig[] {
    return Object.values(this.doc.agents).map(toPublicAgentConfig);
  }

  getAgent(id: string): StoredAgentConfig | undefined {
    return this.doc.agents[id];
  }

  async upsertAgent(input: Omit<StoredAgentConfig, 'id' | 'apiKey' | 'updatedAt'> & { id?: string; apiKey?: string; clearApiKey?: boolean }): Promise<PublicAgentConfig> {
    const id = input.id || `agt_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const existing = this.doc.agents[id];
    const agent: StoredAgentConfig = {
      id,
      name: input.name,
      accountId: input.accountId,
      chatId: input.chatId,
      providerUrl: input.providerUrl,
      model: input.model,
      apiKey: input.clearApiKey ? '' : (input.apiKey || existing?.apiKey || ''),
      systemPrompt: input.systemPrompt,
      tools: input.tools,
      isEnabled: input.isEnabled,
      updatedAt: Date.now(),
    };
    this.doc.agents[id] = agent;
    await this.persist();
    return toPublicAgentConfig(agent);
  }

  async deleteAgent(id: string): Promise<boolean> {
    if (!this.doc.agents[id]) return false;
    delete this.doc.agents[id];
    await this.persist();
    return true;
  }

  getAuthorizedAccount(ownerId: string, accountId: string): StoredAccountRecord | undefined {
    const account = this.doc.accounts[accountId];
    if (!account || account.ownerId !== ownerId) {
      return undefined;
    }
    return account;
  }

  async upsertAccountFromBridge(
    ownerId: string,
    rawPayload: unknown,
    customLabel?: string,
  ): Promise<PublicAccountSummary> {
    const validated: BridgeSessionPayload = validateBridgePayload(rawPayload);
    const now = Date.now();

    const existing = Object.values(this.doc.accounts).find((account) => (
      account.ownerId === ownerId
      && (
        (validated.profile.userId && account.profile.userId === validated.profile.userId)
        || (validated.slot !== undefined && account.slot === validated.slot)
      )
    ));

    const id = existing?.id || `acc_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const defaultLabel = buildDefaultAccountLabel(validated);
    const label = (customLabel?.trim() || existing?.label || defaultLabel).slice(0, 80);

    const record: StoredAccountRecord = {
      id,
      ownerId,
      label,
      slot: validated.slot,
      mainDcId: validated.sessionData.mainDcId,
      wssEndpoint: getWssEndpointForDc(validated.sessionData.mainDcId, Boolean(validated.sessionData.isTest)),
      isTest: Boolean(validated.sessionData.isTest),
      profile: validated.profile,
      sessionData: validated.sessionData,
      linkedAt: existing?.linkedAt || now,
      updatedAt: now,
    };

    this.doc.accounts[id] = record;
    await this.appendAudit({
      actor: 'admin',
      action: 'account.session.import',
      accountId: id,
      status: 'ok',
      detail: `DC ${record.mainDcId} (${record.wssEndpoint})`,
    });

    return toPublicAccountSummary(record);
  }

  async deleteAccount(ownerId: string, accountId: string): Promise<boolean> {
    const existing = this.doc.accounts[accountId];
    if (!existing || existing.ownerId !== ownerId) {
      return false;
    }

    delete this.doc.accounts[accountId];
    await this.appendAudit({
      actor: 'admin',
      action: 'account.session.delete',
      accountId,
      status: 'ok',
      detail: 'Removed encrypted local server session copy',
    });
    return true;
  }

  async appendAudit(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): Promise<void> {
    const sanitizedDetail = entry.detail
      ? String(redactSensitiveData(entry.detail)).slice(0, 240)
      : undefined;

    this.doc.auditLog.push({
      id: `aud_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      timestamp: Date.now(),
      actor: entry.actor,
      action: entry.action,
      accountId: entry.accountId,
      target: entry.target,
      status: entry.status,
      detail: sanitizedDetail,
    });

    if (this.doc.auditLog.length > MAX_AUDIT_ENTRIES) {
      this.doc.auditLog = this.doc.auditLog.slice(-MAX_AUDIT_ENTRIES);
    }

    await this.persist();
  }

  getAuditLog(limit = 50): AuditLogEntry[] {
    const bounded = Math.max(1, Math.min(limit, MAX_AUDIT_ENTRIES));
    return this.doc.auditLog.slice(-bounded).reverse();
  }

  private persist(): Promise<void> {
    const writeTask = this.writeQueue.then(async () => {
      const envelope = encryptJson(this.doc, this.encryptionKey);
      const serialized = `${JSON.stringify(envelope, undefined, 2)}\n`;
      const tempPath = `${this.vaultPath}.${process.pid}.${Date.now()}.tmp`;

      await writeFile(tempPath, serialized, { encoding: 'utf8', mode: FILE_PERMISSIONS });
      try {
        await chmod(tempPath, FILE_PERMISSIONS);
      } catch {
        // Ignore chmod errors on non-POSIX filesystems
      }
      await rename(tempPath, this.vaultPath);
    });

    this.writeQueue = writeTask.catch(() => undefined);
    return writeTask;
  }
}

function toPublicAgentConfig(agent: StoredAgentConfig): PublicAgentConfig {
  const { apiKey, ...publicAgent } = agent;
  return { ...publicAgent, hasApiKey: Boolean(apiKey) };
}

export function toPublicAccountSummary(account: StoredAccountRecord): PublicAccountSummary {
  return {
    id: account.id,
    label: account.label,
    slot: account.slot,
    mainDcId: account.mainDcId,
    wssEndpoint: account.wssEndpoint,
    isTest: account.isTest,
    profile: account.profile,
    linkedAt: account.linkedAt,
    updatedAt: account.updatedAt,
  };
}

function buildDefaultAccountLabel(payload: BridgeSessionPayload): string {
  const fullName = [payload.profile.firstName, payload.profile.lastName].filter(Boolean).join(' ').trim();
  if (fullName) return fullName;
  if (payload.profile.username) return `@${payload.profile.username}`;
  if (payload.profile.userId) return `حساب ${payload.profile.userId}`;
  return `حساب DC${payload.sessionData.mainDcId}`;
}
