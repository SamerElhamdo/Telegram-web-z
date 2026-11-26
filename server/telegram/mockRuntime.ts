import type { StoredAccountRecord } from '../storage/sessionVault';
import type {
  AccountRuntimeStatus,
  CreateChannelParams,
  CreateGroupParams,
  DialogSummary,
  ListDialogsParams,
  MarkChatReadParams,
  MessageSummary,
  ReadMessagesParams,
  SearchMessagesParams,
  SendMessageParams,
  TelegramAccountRuntime,
} from './types';

type MockAccountDataset = {
  dialogs: DialogSummary[];
  messagesByChat: Record<string, MessageSummary[]>;
  nextMessageId: number;
  nextChatNumericId: number;
};

export class MockTelegramAccountRuntime implements TelegramAccountRuntime {
  readonly mode = 'mock' as const;
  private readonly datasets = new Map<string, MockAccountDataset>();

  async getAccountStatus(account: StoredAccountRecord): Promise<AccountRuntimeStatus> {
    const displayName = [account.profile.firstName, account.profile.lastName].filter(Boolean).join(' ').trim()
      || account.label;

    return {
      accountId: account.id,
      mainDcId: account.mainDcId,
      wssEndpoint: account.wssEndpoint,
      transport: 'wss',
      connected: true,
      authorized: true,
      mode: 'mock',
      userId: account.profile.userId || '990001',
      displayName,
      checkedAt: Date.now(),
    };
  }

  async listDialogs(account: StoredAccountRecord, params: ListDialogsParams): Promise<DialogSummary[]> {
    const dataset = this.getOrCreateDataset(account.id);
    const filtered = dataset.dialogs.filter((dialog) => Boolean(dialog.isArchived) === Boolean(params.archived));
    return filtered.slice(0, params.limit);
  }

  async readMessages(account: StoredAccountRecord, params: ReadMessagesParams): Promise<MessageSummary[]> {
    const dataset = this.getOrCreateDataset(account.id);
    const messages = dataset.messagesByChat[params.chatId];
    if (!messages) {
      throw new Error(`Chat "${params.chatId}" not found for this account`);
    }

    const filtered = params.offsetId
      ? messages.filter((msg) => msg.id < params.offsetId!)
      : messages;

    return filtered.slice(-params.limit).reverse();
  }

  async searchMessages(account: StoredAccountRecord, params: SearchMessagesParams): Promise<MessageSummary[]> {
    const dataset = this.getOrCreateDataset(account.id);
    const normalizedQuery = params.query.trim().toLowerCase();
    const targetChats = params.chatId
      ? (dataset.messagesByChat[params.chatId] ? [dataset.messagesByChat[params.chatId]] : [])
      : Object.values(dataset.messagesByChat);

    const matches: MessageSummary[] = [];
    for (const list of targetChats) {
      for (const msg of list) {
        if (msg.text.toLowerCase().includes(normalizedQuery)) {
          matches.push(msg);
        }
      }
    }

    return matches
      .sort((a, b) => b.date - a.date)
      .slice(0, params.limit);
  }

  async sendMessage(
    account: StoredAccountRecord,
    params: SendMessageParams,
  ): Promise<{ messageId: number; chatId: string; date: number }> {
    const dataset = this.getOrCreateDataset(account.id);
    const dialog = dataset.dialogs.find((item) => item.chatId === params.chatId);
    if (!dialog) {
      throw new Error(`Target chat "${params.chatId}" not found for this account`);
    }

    const id = dataset.nextMessageId++;
    const date = Math.floor(Date.now() / 1000);
    const message: MessageSummary = {
      id,
      chatId: params.chatId,
      senderId: account.profile.userId || '990001',
      senderName: account.label,
      date,
      text: params.text,
      isOutgoing: true,
      replyToMsgId: params.replyToMsgId,
    };

    dataset.messagesByChat[params.chatId] = dataset.messagesByChat[params.chatId] || [];
    dataset.messagesByChat[params.chatId].push(message);
    dialog.lastMessageId = id;
    dialog.lastMessageDate = date;
    dialog.lastMessagePreview = params.text.slice(0, 120);

    return {
      messageId: id,
      chatId: params.chatId,
      date,
    };
  }

  async createGroup(
    account: StoredAccountRecord,
    params: CreateGroupParams,
  ): Promise<{ chatId: string; title: string }> {
    const dataset = this.getOrCreateDataset(account.id);
    const chatId = `-${dataset.nextChatNumericId++}`;
    dataset.dialogs.unshift({
      chatId,
      title: params.title,
      type: 'group',
      unreadCount: 0,
      lastMessageDate: Math.floor(Date.now() / 1000),
      lastMessagePreview: `تم إنشاء المجموعة (${params.userIds.length} أعضاء)`,
    });
    dataset.messagesByChat[chatId] = [];
    return { chatId, title: params.title };
  }

  async createChannel(
    account: StoredAccountRecord,
    params: CreateChannelParams,
  ): Promise<{ chatId: string; title: string; isMegagroup: boolean }> {
    const dataset = this.getOrCreateDataset(account.id);
    const chatId = `-100${dataset.nextChatNumericId++}`;
    const isMegagroup = Boolean(params.isMegagroup);
    dataset.dialogs.unshift({
      chatId,
      title: params.title,
      type: isMegagroup ? 'supergroup' : 'channel',
      unreadCount: 0,
      lastMessageDate: Math.floor(Date.now() / 1000),
      lastMessagePreview: params.about || 'تم إنشاء القناة',
    });
    dataset.messagesByChat[chatId] = [];
    return { chatId, title: params.title, isMegagroup };
  }

  async markChatRead(
    account: StoredAccountRecord,
    params: MarkChatReadParams,
  ): Promise<{ chatId: string; maxId: number; affectedCount: number }> {
    const dataset = this.getOrCreateDataset(account.id);
    const dialog = dataset.dialogs.find((item) => item.chatId === params.chatId);
    if (!dialog) {
      throw new Error(`Target chat "${params.chatId}" not found for this account`);
    }

    const previousUnread = dialog.unreadCount;
    dialog.unreadCount = 0;

    return {
      chatId: params.chatId,
      maxId: params.maxId || dialog.lastMessageId || 0,
      affectedCount: previousUnread,
    };
  }

  async disconnectAccount(accountId: string): Promise<void> {
    this.datasets.delete(accountId);
  }

  async shutdown(): Promise<void> {
    this.datasets.clear();
  }

  private getOrCreateDataset(accountId: string): MockAccountDataset {
    let dataset = this.datasets.get(accountId);
    if (dataset) return dataset;

    const nowSec = Math.floor(Date.now() / 1000);
    dataset = {
      dialogs: [
        {
          chatId: '777000',
          title: 'الرسائل المحفوظة (محاكاة)',
          type: 'user',
          unreadCount: 0,
          lastMessageId: 102,
          lastMessageDate: nowSec - 120,
          lastMessagePreview: 'تذكير: مراجعة إعدادات MCP قبل النشر',
        },
        {
          chatId: '-1001234567890',
          title: 'فريق الهندسة (محاكاة)',
          type: 'supergroup',
          username: 'mock_engineering_team',
          unreadCount: 2,
          lastMessageId: 205,
          lastMessageDate: nowSec - 60,
          lastMessagePreview: 'تم تحديث طبقة WSS وفحص التشفير بنجاح',
        },
      ],
      messagesByChat: {
        777000: [
          {
            id: 101,
            chatId: '777000',
            senderId: '777000',
            senderName: 'الرسائل المحفوظة',
            date: nowSec - 300,
            text: 'أهلاً بك في وضع المحاكاة الآمن.',
            isOutgoing: true,
          },
          {
            id: 102,
            chatId: '777000',
            senderId: '777000',
            senderName: 'الرسائل المحفوظة',
            date: nowSec - 120,
            text: 'تذكير: مراجعة إعدادات MCP قبل النشر',
            isOutgoing: true,
          },
        ],
        '-1001234567890': [
          {
            id: 204,
            chatId: '-1001234567890',
            senderId: '5001',
            senderName: 'سارة',
            date: nowSec - 180,
            text: 'هل تم تفعيل موافقة المستخدم على أدوات الكتابة في MCP؟',
            isOutgoing: false,
          },
          {
            id: 205,
            chatId: '-1001234567890',
            senderId: '5002',
            senderName: 'طارق',
            date: nowSec - 60,
            text: 'تم تحديث طبقة WSS وفحص التشفير بنجاح',
            isOutgoing: false,
          },
        ],
      },
      nextMessageId: 500,
      nextChatNumericId: 2000001,
    };

    this.datasets.set(accountId, dataset);
    return dataset;
  }
}
