import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { ApprovalStore, WriteActionType } from '../approvals/approvalStore';
import type { EncryptedSessionVault } from '../storage/sessionVault';
import type { TelegramAccountRuntime } from '../telegram/types';

export type McpServiceDependencies = {
  ownerId: string;
  vault: EncryptedSessionVault;
  approvals: ApprovalStore;
  runtime: TelegramAccountRuntime;
  serverVersion: string;
};

const MAX_DIALOGS_LIMIT = 100;
const MAX_MESSAGES_LIMIT = 100;
const MAX_SEARCH_LIMIT = 50;
const MAX_MESSAGE_TEXT_LENGTH = 4096;
const MAX_GROUP_USERS = 50;
const ACCOUNT_ID_SCHEMA = z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9_-]+$/);
const CHAT_ID_SCHEMA = z.string().trim().min(1).max(64).regex(/^-?\d+$/);
const APPROVAL_ID_SCHEMA = z.string().trim().min(6).max(64).regex(/^apr_[a-zA-Z0-9]+$/);

export const MCP_TOOL_CATALOG = [
  {
    name: 'list_accounts',
    category: 'read',
    requiresApproval: false,
    description: 'عرض قائمة الحسابات المرتبطة والمصرّح بها فقط (بدون مفاتيح أو أسرار جلسة).',
  },
  {
    name: 'list_dialogs',
    category: 'read',
    requiresApproval: false,
    description: 'جلب قائمة المحادثات لحساب محدد مع حد أقصى مضبوط للنتائج.',
  },
  {
    name: 'read_messages',
    category: 'read',
    requiresApproval: false,
    description: 'قراءة رسائل محادثة محددة ضمن حساب مصرح به.',
  },
  {
    name: 'search_messages',
    category: 'read',
    requiresApproval: false,
    description: 'البحث النصي داخل محادثة محددة أو عبر محادثات الحساب المصرح به.',
  },
  {
    name: 'send_message',
    category: 'write',
    requiresApproval: true,
    description: 'إرسال رسالة إلى محادثة محددة — يتطلب موافقة صريحة من المستخدم قبل التنفيذ.',
  },
  {
    name: 'create_group',
    category: 'write',
    requiresApproval: true,
    description: 'إنشاء مجموعة جديدة — يتطلب موافقة صريحة من المستخدم قبل التنفيذ.',
  },
  {
    name: 'create_channel',
    category: 'write',
    requiresApproval: true,
    description: 'إنشاء قناة أو مجموعة فائقة — يتطلب موافقة صريحة من المستخدم قبل التنفيذ.',
  },
  {
    name: 'mark_chat_read',
    category: 'write',
    requiresApproval: true,
    description: 'تحديد المحادثة كمقروءة — يتطلب موافقة صريحة من المستخدم قبل التنفيذ.',
  },
] as const;

export function createTelegramMcpHandler(deps: McpServiceDependencies) {
  return createMcpHandler(
    () => buildConfiguredMcpServer(deps),
    {
      legacy: 'stateless',
      responseMode: 'auto',
    },
  );
}

export function buildConfiguredMcpServer(deps: McpServiceDependencies): McpServer {
  const { ownerId, vault, approvals, runtime, serverVersion } = deps;

  const server = new McpServer({
    name: 'telegram-web-z-account-mcp',
    version: serverVersion,
  });

  // Read tool 1: list_accounts
  server.registerTool(
    'list_accounts',
    {
      description: 'List authorized Telegram accounts linked to this private manager (never returns session keys).',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const accounts = vault.listAccounts(ownerId);
      await vault.appendAudit({
        actor: 'mcp',
        action: 'mcp.list_accounts',
        status: 'ok',
        detail: `Returned ${accounts.length} authorized account(s)`,
      });

      return jsonToolResult({
        accounts,
        runtimeMode: runtime.mode,
      });
    },
  );

  // Read tool 2: list_dialogs
  server.registerTool(
    'list_dialogs',
    {
      description: 'List dialogs (chats, groups, channels) for an authorized Telegram account.',
      inputSchema: {
        accountId: ACCOUNT_ID_SCHEMA,
        limit: z.number().int().min(1).max(MAX_DIALOGS_LIMIT).default(25),
        archived: z.boolean().optional().default(false),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ accountId, limit, archived }) => {
      const account = vault.getAuthorizedAccount(ownerId, accountId);
      if (!account) {
        await vault.appendAudit({
          actor: 'mcp',
          action: 'mcp.list_dialogs',
          accountId,
          status: 'denied',
          detail: 'Unauthorized or unknown accountId',
        });
        return errorToolResult(`Account "${accountId}" is not authorized or does not exist.`);
      }

      const dialogs = await runtime.listDialogs(account, { limit, archived });
      await vault.appendAudit({
        actor: 'mcp',
        action: 'mcp.list_dialogs',
        accountId,
        status: 'ok',
        detail: `Fetched ${dialogs.length} dialog(s)`,
      });

      return jsonToolResult({
        accountId: account.id,
        accountLabel: account.label,
        dialogs,
      });
    },
  );

  // Read tool 3: read_messages
  server.registerTool(
    'read_messages',
    {
      description: 'Read recent messages from a specific chat in an authorized Telegram account.',
      inputSchema: {
        accountId: ACCOUNT_ID_SCHEMA,
        chatId: CHAT_ID_SCHEMA,
        limit: z.number().int().min(1).max(MAX_MESSAGES_LIMIT).default(20),
        offsetId: z.number().int().min(0).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ accountId, chatId, limit, offsetId }) => {
      const account = vault.getAuthorizedAccount(ownerId, accountId);
      if (!account) {
        await vault.appendAudit({
          actor: 'mcp',
          action: 'mcp.read_messages',
          accountId,
          target: chatId,
          status: 'denied',
          detail: 'Unauthorized or unknown accountId',
        });
        return errorToolResult(`Account "${accountId}" is not authorized or does not exist.`);
      }

      const messages = await runtime.readMessages(account, { chatId, limit, offsetId });
      await vault.appendAudit({
        actor: 'mcp',
        action: 'mcp.read_messages',
        accountId,
        target: chatId,
        status: 'ok',
        detail: `Read ${messages.length} message(s)`,
      });

      return jsonToolResult({
        accountId: account.id,
        chatId,
        messages,
      });
    },
  );

  // Read tool 4: search_messages
  server.registerTool(
    'search_messages',
    {
      description: 'Search messages within a chat or across an authorized Telegram account.',
      inputSchema: {
        accountId: ACCOUNT_ID_SCHEMA,
        query: z.string().trim().min(1).max(256),
        chatId: CHAT_ID_SCHEMA.optional(),
        limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).default(20),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ accountId, query, chatId, limit }) => {
      const account = vault.getAuthorizedAccount(ownerId, accountId);
      if (!account) {
        await vault.appendAudit({
          actor: 'mcp',
          action: 'mcp.search_messages',
          accountId,
          target: chatId,
          status: 'denied',
          detail: 'Unauthorized or unknown accountId',
        });
        return errorToolResult(`Account "${accountId}" is not authorized or does not exist.`);
      }

      const messages = await runtime.searchMessages(account, { query, chatId, limit });
      await vault.appendAudit({
        actor: 'mcp',
        action: 'mcp.search_messages',
        accountId,
        target: chatId || 'global',
        status: 'ok',
        detail: `Matched ${messages.length} message(s)`,
      });

      return jsonToolResult({
        accountId: account.id,
        chatId,
        query,
        messages,
      });
    },
  );

  // Write tool 1 (explicit approval required): send_message
  server.registerTool(
    'send_message',
    {
      description: 'Send a text message to a Telegram chat. Requires explicit user approval before execution.',
      inputSchema: {
        accountId: ACCOUNT_ID_SCHEMA,
        chatId: CHAT_ID_SCHEMA,
        text: z.string().trim().min(1).max(MAX_MESSAGE_TEXT_LENGTH),
        replyToMsgId: z.number().int().positive().optional(),
        approvalId: APPROVAL_ID_SCHEMA.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ accountId, chatId, text, replyToMsgId, approvalId }) => (
      handleApprovalGatedWrite({
        deps,
        action: 'send_message',
        accountId,
        targetLabel: `محادثة ${chatId}`,
        payload: { chatId, text, replyToMsgId },
        approvalId,
        execute: async (account) => runtime.sendMessage(account, { chatId, text, replyToMsgId }),
      })
    ),
  );

  // Write tool 2 (explicit approval required): create_group
  server.registerTool(
    'create_group',
    {
      description: 'Create a Telegram group with specified user IDs. Requires explicit user approval before execution.',
      inputSchema: {
        accountId: ACCOUNT_ID_SCHEMA,
        title: z.string().trim().min(1).max(128),
        userIds: z.array(z.string().trim().regex(/^\d+$/)).min(1).max(MAX_GROUP_USERS),
        approvalId: APPROVAL_ID_SCHEMA.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ accountId, title, userIds, approvalId }) => (
      handleApprovalGatedWrite({
        deps,
        action: 'create_group',
        accountId,
        targetLabel: `مجموعة جديدة: ${title}`,
        payload: { title, userIds },
        approvalId,
        execute: async (account) => runtime.createGroup(account, { title, userIds }),
      })
    ),
  );

  // Write tool 3 (explicit approval required): create_channel
  server.registerTool(
    'create_channel',
    {
      description: 'Create a Telegram channel or supergroup. Requires explicit user approval before execution.',
      inputSchema: {
        accountId: ACCOUNT_ID_SCHEMA,
        title: z.string().trim().min(1).max(128),
        about: z.string().trim().max(255).optional().default(''),
        isMegagroup: z.boolean().optional().default(false),
        approvalId: APPROVAL_ID_SCHEMA.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ accountId, title, about, isMegagroup, approvalId }) => (
      handleApprovalGatedWrite({
        deps,
        action: 'create_channel',
        accountId,
        targetLabel: `${isMegagroup ? 'مجموعة فائقة' : 'قناة'} جديدة: ${title}`,
        payload: { title, about, isMegagroup },
        approvalId,
        execute: async (account) => runtime.createChannel(account, { title, about, isMegagroup }),
      })
    ),
  );

  // Write tool 4 (explicit approval required): mark_chat_read
  server.registerTool(
    'mark_chat_read',
    {
      description: 'Mark a Telegram chat as read. Requires explicit user approval before execution.',
      inputSchema: {
        accountId: ACCOUNT_ID_SCHEMA,
        chatId: CHAT_ID_SCHEMA,
        maxId: z.number().int().min(0).optional(),
        approvalId: APPROVAL_ID_SCHEMA.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ accountId, chatId, maxId, approvalId }) => (
      handleApprovalGatedWrite({
        deps,
        action: 'mark_chat_read',
        accountId,
        targetLabel: `محادثة ${chatId}`,
        payload: { chatId, maxId },
        approvalId,
        execute: async (account) => runtime.markChatRead(account, { chatId, maxId }),
      })
    ),
  );

  return server;
}

async function handleApprovalGatedWrite(params: {
  deps: McpServiceDependencies;
  action: WriteActionType;
  accountId: string;
  targetLabel: string;
  payload: Record<string, unknown>;
  approvalId?: string;
  execute: (account: NonNullable<ReturnType<EncryptedSessionVault['getAuthorizedAccount']>>) => Promise<Record<string, unknown>>;
}) {
  const { deps, action, accountId, targetLabel, payload, approvalId, execute } = params;
  const { ownerId, vault, approvals } = deps;

  const account = vault.getAuthorizedAccount(ownerId, accountId);
  if (!account) {
    await vault.appendAudit({
      actor: 'mcp',
      action: `mcp.${action}`,
      accountId,
      target: targetLabel,
      status: 'denied',
      detail: 'Unauthorized or unknown accountId',
    });
    return errorToolResult(`Account "${accountId}" is not authorized or does not exist.`);
  }

  if (!approvalId) {
    const pending = approvals.createPending({
      ownerId,
      accountId: account.id,
      accountLabel: account.label,
      action,
      targetLabel,
      payload,
    });

    await vault.appendAudit({
      actor: 'mcp',
      action: `mcp.${action}`,
      accountId: account.id,
      target: targetLabel,
      status: 'pending_approval',
      detail: `Created approval request ${pending.id}`,
    });

    return jsonToolResult({
      status: 'approval_required',
      approvalId: pending.id,
      accountId: account.id,
      accountLabel: account.label,
      action,
      target: targetLabel,
      expiresAt: pending.expiresAt,
      message: 'هذا الإجراء المؤثر يتطلب موافقة صريحة من المستخدم عبر لوحة الإدارة و MCP قبل التنفيذ.',
    });
  }

  try {
    approvals.consumeApprovedForExecution({
      ownerId,
      approvalId,
      accountId: account.id,
      action,
      payload,
    });
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : 'Approval verification failed';
    await vault.appendAudit({
      actor: 'mcp',
      action: `mcp.${action}`,
      accountId: account.id,
      target: targetLabel,
      status: 'denied',
      detail: reason,
    });
    return errorToolResult(`Approval verification failed: ${reason}`);
  }

  try {
    const result = await execute(account);
    approvals.markExecuted(ownerId, approvalId, result);
    await vault.appendAudit({
      actor: 'mcp',
      action: `mcp.${action}`,
      accountId: account.id,
      target: targetLabel,
      status: 'ok',
      detail: `Executed with explicit approval ${approvalId}`,
    });

    return jsonToolResult({
      status: 'executed',
      approvalId,
      accountId: account.id,
      accountLabel: account.label,
      action,
      result,
    });
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Execution failed';
    approvals.markExecuted(ownerId, approvalId, undefined, errorMessage);
    await vault.appendAudit({
      actor: 'mcp',
      action: `mcp.${action}`,
      accountId: account.id,
      target: targetLabel,
      status: 'error',
      detail: errorMessage,
    });
    return errorToolResult(`Action execution failed: ${errorMessage}`);
  }
}

function jsonToolResult(data: Record<string, unknown>) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, undefined, 2),
      },
    ],
  };
}

function errorToolResult(message: string) {
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: message,
      },
    ],
  };
}
