import type { StoredAccountRecord } from '../storage/sessionVault';

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

export type AccountRuntimeStatus = {
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

export type ListDialogsParams = {
  limit: number;
  archived?: boolean;
};

export type ReadMessagesParams = {
  chatId: string;
  limit: number;
  offsetId?: number;
};

export type SearchMessagesParams = {
  query: string;
  chatId?: string;
  limit: number;
};

export type SendMessageParams = {
  chatId: string;
  text: string;
  replyToMsgId?: number;
};

export type CreateGroupParams = {
  title: string;
  userIds: string[];
};

export type CreateChannelParams = {
  title: string;
  about?: string;
  isMegagroup?: boolean;
};

export type MarkChatReadParams = {
  chatId: string;
  maxId?: number;
};

export interface TelegramAccountRuntime {
  readonly mode: 'gramjs' | 'mock';
  getAccountStatus(account: StoredAccountRecord): Promise<AccountRuntimeStatus>;
  listDialogs(account: StoredAccountRecord, params: ListDialogsParams): Promise<DialogSummary[]>;
  readMessages(account: StoredAccountRecord, params: ReadMessagesParams): Promise<MessageSummary[]>;
  searchMessages(account: StoredAccountRecord, params: SearchMessagesParams): Promise<MessageSummary[]>;
  sendMessage(account: StoredAccountRecord, params: SendMessageParams): Promise<{ messageId: number; chatId: string; date: number }>;
  createGroup(account: StoredAccountRecord, params: CreateGroupParams): Promise<{ chatId: string; title: string }>;
  createChannel(account: StoredAccountRecord, params: CreateChannelParams): Promise<{ chatId: string; title: string; isMegagroup: boolean }>;
  markChatRead(account: StoredAccountRecord, params: MarkChatReadParams): Promise<{ chatId: string; maxId: number; affectedCount: number }>;
  disconnectAccount(accountId: string): Promise<void>;
  shutdown(): Promise<void>;
}
