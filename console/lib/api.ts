import type { BridgeAccountProfile, BridgeSessionPayload } from '../../src/shared/sessionBridge';

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

export type PublicAgentConfig = {
  id: string;
  name: string;
  accountId: string;
  chatId: string;
  providerUrl: string;
  model: string;
  systemPrompt: string;
  tools: Array<'read_group_messages' | 'search_group_messages' | 'reply_to_group'>;
  isEnabled: boolean;
  hasApiKey: boolean;
  updatedAt: number;
};

export type AccountStatus = {
  accountId: string;
  mainDcId: number;
  wssEndpoint: string;
  transport: 'wss';
  connected: boolean;
  authorized: boolean;
  mode: 'gramjs' | 'mock';
  userId?: string;
  displayName?: string;
  checkedAt: number;
  error?: string;
};

export type DialogSummary = {
  chatId: string;
  title: string;
  type: 'user' | 'group' | 'supergroup' | 'channel';
  username?: string;
  unreadCount: number;
  lastMessageId?: number;
  lastMessageDate?: number;
  lastMessagePreview?: string;
  isArchived?: boolean;
};

export type MessageSummary = {
  id: number;
  chatId: string;
  senderId?: string;
  senderName?: string;
  date: number;
  text: string;
  isOutgoing: boolean;
  replyToMsgId?: number;
};

export type ApprovalItem = {
  id: string;
  accountId: string;
  accountLabel: string;
  action: 'send_message' | 'create_group' | 'create_channel' | 'mark_chat_read';
  targetLabel: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'expired';
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
  executedAt?: number;
  executionResult?: Record<string, unknown>;
  error?: string;
};

export type McpToolInfo = {
  name: string;
  category: 'read' | 'write';
  requiresApproval: boolean;
  description: string;
};

export type McpSettingsResponse = {
  endpointUrl: string;
  transport: string;
  authScheme: string;
  httpsEnforced: boolean;
  runtimeMode: 'gramjs' | 'mock';
  allowedOrigins: string[];
  hasPreviousToken: boolean;
  rotatedAt?: number;
  tools: McpToolInfo[];
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

export type AuthMeResponse = {
  authenticated: boolean;
  csrfToken?: string;
  ownerId?: string;
  runtimeMode?: 'gramjs' | 'mock';
};

let currentCsrfToken: string | undefined;

export function setCsrfToken(token?: string) {
  currentCsrfToken = token;
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const method = (init.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && currentCsrfToken) {
    headers.set('X-CSRF-Token', currentCsrfToken);
  }

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: 'same-origin',
  });

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { error: text || `HTTP ${response.status}` };
  }

  if (!response.ok) {
    const errorMessage = (parsed && typeof parsed === 'object' && 'error' in parsed && typeof parsed.error === 'string')
      ? parsed.error
      : `فشل الطلب برمز ${response.status}`;
    throw new Error(errorMessage);
  }

  return parsed as T;
}

export const consoleApi = {
  getAuthMe: () => apiFetch<AuthMeResponse>('/api/auth/me'),
  login: (token: string) => apiFetch<AuthMeResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ token }),
  }),
  logout: () => apiFetch<{ authenticated: boolean }>('/api/auth/logout', { method: 'POST' }),
  listAccounts: () => apiFetch<{ accounts: PublicAccountSummary[]; runtimeMode: 'gramjs' | 'mock'; disclaimer: string }>('/api/accounts'),
  listAgents: () => apiFetch<{ agents: PublicAgentConfig[] }>('/api/agents'),
  saveAgent: (agent: Omit<PublicAgentConfig, 'id' | 'hasApiKey' | 'updatedAt'> & { id?: string; apiKey?: string; clearApiKey?: boolean }) => (
    apiFetch<{ agent: PublicAgentConfig }>('/api/agents', { method: 'POST', body: JSON.stringify(agent) })
  ),
  deleteAgent: (id: string) => apiFetch<{ deleted: boolean }>(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  importSession: (payload: BridgeSessionPayload, label?: string) => (
    apiFetch<{ account: PublicAccountSummary; notice: string }>('/api/accounts/import-session', {
      method: 'POST',
      body: JSON.stringify({ payload, label }),
    })
  ),
  getAccountStatus: (accountId: string) => (
    apiFetch<{ status: AccountStatus }>(`/api/accounts/${encodeURIComponent(accountId)}/status`)
  ),
  deleteAccount: (accountId: string) => (
    apiFetch<{ deleted: boolean; accountId: string; revocationNotice: string }>(
      `/api/accounts/${encodeURIComponent(accountId)}`,
      { method: 'DELETE' },
    )
  ),
  listDialogs: (accountId: string, limit = 30) => (
    apiFetch<{ dialogs: DialogSummary[] }>(`/api/accounts/${encodeURIComponent(accountId)}/dialogs?limit=${limit}`)
  ),
  readMessages: (accountId: string, chatId: string, limit = 30) => (
    apiFetch<{ messages: MessageSummary[] }>(
      `/api/accounts/${encodeURIComponent(accountId)}/messages?chatId=${encodeURIComponent(chatId)}&limit=${limit}`,
    )
  ),
  searchMessages: (accountId: string, query: string, chatId?: string, limit = 25) => {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (chatId) params.set('chatId', chatId);
    return apiFetch<{ messages: MessageSummary[] }>(
      `/api/accounts/${encodeURIComponent(accountId)}/search?${params.toString()}`,
    );
  },
  sendMessage: (
    accountId: string,
    params: { chatId: string; text: string; replyToMsgId?: number },
  ) => apiFetch<{ sent: { messageId: number; chatId: string; date: number } }>(
    `/api/accounts/${encodeURIComponent(accountId)}/send`,
    {
      method: 'POST',
      body: JSON.stringify({
        ...params,
        confirmedTargetAccountId: accountId,
        confirmedTargetChatId: params.chatId,
      }),
    },
  ),
  listApprovals: () => apiFetch<{ approvals: ApprovalItem[] }>('/api/approvals'),
  approveAction: (id: string) => apiFetch<{ approval: ApprovalItem; result?: Record<string, unknown> }>(
    `/api/approvals/${encodeURIComponent(id)}/approve`,
    {
      method: 'POST',
      body: JSON.stringify({ executeNow: true }),
    },
  ),
  rejectAction: (id: string, reason?: string) => apiFetch<{ approval: ApprovalItem }>(
    `/api/approvals/${encodeURIComponent(id)}/reject`,
    {
      method: 'POST',
      body: JSON.stringify({ reason }),
    },
  ),
  getMcpSettings: () => apiFetch<McpSettingsResponse>('/api/mcp/settings'),
  rotateMcpToken: (keepPrevious: boolean) => apiFetch<{
    newToken: string;
    rotatedAt: number;
    keepPrevious: boolean;
    warning: string;
  }>('/api/mcp/rotate-token', {
    method: 'POST',
    body: JSON.stringify({ keepPrevious }),
  }),
  getAuditLog: (limit = 40) => apiFetch<{ entries: AuditLogEntry[] }>(`/api/audit?limit=${limit}`),
};
