import { randomBytes } from 'node:crypto';

import type Api from '../../src/lib/gramjs/tl/api';
import type { StoredAccountRecord } from '../storage/sessionVault';
import type { GramJsClientInstance, GramJsRuntimeModule } from './gramjsLoader';
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

import { loadProjectGramJs } from './gramjsLoader';

type ManagedClientEntry = {
  gramjs: GramJsRuntimeModule;
  client: GramJsClientInstance;
  inputPeers: Map<string, Api.TypeInputPeer>;
  inputUsers: Map<string, Api.TypeInputUser>;
  lastUsedAt: number;
};

const CONNECT_TIMEOUT_MS = 15000;
const REQUEST_TIMEOUT_MS = 15000;

export class GramJsTelegramAccountRuntime implements TelegramAccountRuntime {
  readonly mode = 'gramjs' as const;
  private readonly apiId: number;
  private readonly apiHash: string;
  private readonly clients = new Map<string, ManagedClientEntry>();

  constructor(options: { apiId: number; apiHash: string }) {
    this.apiId = options.apiId;
    this.apiHash = options.apiHash;
  }

  async getAccountStatus(account: StoredAccountRecord): Promise<AccountRuntimeStatus> {
    let gramjs: GramJsRuntimeModule | undefined;
    try {
      const entry = await this.getOrConnectClient(account);
      gramjs = entry.gramjs;
      const { Api: GramJs } = gramjs;
      const userFull = await withTimeout(
        entry.client.invoke(new GramJs.users.GetFullUser({ id: new GramJs.InputUserSelf() })),
        REQUEST_TIMEOUT_MS,
      );
      const selfUser = userFull.users.find((u): u is Api.User => u instanceof GramJs.User && Boolean(u.self));
      const displayName = selfUser
        ? [selfUser.firstName, selfUser.lastName].filter(Boolean).join(' ').trim() || selfUser.username
        : account.label;

      return {
        accountId: account.id,
        mainDcId: account.mainDcId,
        wssEndpoint: account.wssEndpoint,
        transport: 'wss',
        connected: entry.client.isConnected(),
        authorized: Boolean(selfUser),
        mode: 'gramjs',
        userId: selfUser ? String(selfUser.id) : account.profile.userId,
        displayName,
        checkedAt: Date.now(),
      };
    } catch (err: unknown) {
      return {
        accountId: account.id,
        mainDcId: account.mainDcId,
        wssEndpoint: account.wssEndpoint,
        transport: 'wss',
        connected: false,
        authorized: false,
        mode: 'gramjs',
        userId: account.profile.userId,
        displayName: account.label,
        checkedAt: Date.now(),
        error: formatTelegramError(err, gramjs),
      };
    }
  }

  async listDialogs(account: StoredAccountRecord, params: ListDialogsParams): Promise<DialogSummary[]> {
    const entry = await this.getOrConnectClient(account);
    const { Api: GramJs } = entry.gramjs;
    try {
      const response = await withTimeout(
        entry.client.invoke(new GramJs.messages.GetDialogs({
          offsetDate: 0,
          offsetId: 0,
          offsetPeer: new GramJs.InputPeerEmpty(),
          limit: params.limit,
          hash: BigInt(0),
          folderId: params.archived ? 1 : 0,
        })),
        REQUEST_TIMEOUT_MS,
      );

      if (response instanceof GramJs.messages.DialogsNotModified) {
        return [];
      }

      this.cacheEntities(entry, response.users, response.chats);

      const userMap = new Map<string, Api.User>();
      for (const user of response.users) {
        if (user instanceof GramJs.User) {
          userMap.set(String(user.id), user);
        }
      }

      const chatMap = new Map<string, Api.Chat | Api.Channel>();
      for (const chat of response.chats) {
        if (chat instanceof GramJs.Chat || chat instanceof GramJs.Channel) {
          chatMap.set(String(chat.id), chat);
        }
      }

      const messageMap = new Map<string, Api.Message>();
      for (const msg of response.messages) {
        if (msg instanceof GramJs.Message) {
          const peerId = extractChatIdFromPeer(GramJs, msg.peerId);
          if (peerId) {
            messageMap.set(`${peerId}:${msg.id}`, msg);
          }
        }
      }

      const summaries: DialogSummary[] = [];
      for (const dialog of response.dialogs) {
        if (!(dialog instanceof GramJs.Dialog)) continue;
        const chatId = extractChatIdFromPeer(GramJs, dialog.peer);
        if (!chatId) continue;

        const peerInfo = resolvePeerSummary(GramJs, dialog.peer, userMap, chatMap);
        const topMsg = messageMap.get(`${chatId}:${dialog.topMessage}`);

        summaries.push({
          chatId,
          title: peerInfo.title,
          type: peerInfo.type,
          username: peerInfo.username,
          unreadCount: dialog.unreadCount,
          lastMessageId: dialog.topMessage || undefined,
          lastMessageDate: topMsg?.date,
          lastMessagePreview: topMsg?.message ? topMsg.message.slice(0, 140) : undefined,
          isArchived: Boolean(params.archived),
        });
      }

      return summaries.slice(0, params.limit);
    } catch (err: unknown) {
      throw new Error(formatTelegramError(err, entry.gramjs));
    }
  }

  async readMessages(account: StoredAccountRecord, params: ReadMessagesParams): Promise<MessageSummary[]> {
    const entry = await this.getOrConnectClient(account);
    const { Api: GramJs } = entry.gramjs;
    const peer = await this.resolveInputPeer(account, entry, params.chatId);

    try {
      const response = await withTimeout(
        entry.client.invoke(new GramJs.messages.GetHistory({
          peer,
          offsetId: params.offsetId || 0,
          offsetDate: 0,
          addOffset: 0,
          limit: params.limit,
          maxId: 0,
          minId: 0,
          hash: BigInt(0),
        })),
        REQUEST_TIMEOUT_MS,
      );

      if (response instanceof GramJs.messages.MessagesNotModified) {
        return [];
      }

      this.cacheEntities(entry, response.users, response.chats);
      return buildMessageSummaries(GramJs, params.chatId, response.messages, response.users, response.chats);
    } catch (err: unknown) {
      throw new Error(formatTelegramError(err, entry.gramjs));
    }
  }

  async searchMessages(account: StoredAccountRecord, params: SearchMessagesParams): Promise<MessageSummary[]> {
    const entry = await this.getOrConnectClient(account);
    const { Api: GramJs } = entry.gramjs;

    try {
      if (params.chatId) {
        const peer = await this.resolveInputPeer(account, entry, params.chatId);
        const response = await withTimeout(
          entry.client.invoke(new GramJs.messages.Search({
            peer,
            q: params.query,
            filter: new GramJs.InputMessagesFilterEmpty(),
            minDate: 0,
            maxDate: 0,
            offsetId: 0,
            addOffset: 0,
            limit: params.limit,
            maxId: 0,
            minId: 0,
            hash: BigInt(0),
          })),
          REQUEST_TIMEOUT_MS,
        );

        if (response instanceof GramJs.messages.MessagesNotModified) {
          return [];
        }

        this.cacheEntities(entry, response.users, response.chats);
        return buildMessageSummaries(GramJs, params.chatId, response.messages, response.users, response.chats);
      }

      const response = await withTimeout(
        entry.client.invoke(new GramJs.messages.SearchGlobal({
          q: params.query,
          filter: new GramJs.InputMessagesFilterEmpty(),
          minDate: 0,
          maxDate: 0,
          offsetRate: 0,
          offsetPeer: new GramJs.InputPeerEmpty(),
          offsetId: 0,
          limit: params.limit,
        })),
        REQUEST_TIMEOUT_MS,
      );

      if (response instanceof GramJs.messages.MessagesNotModified) {
        return [];
      }

      this.cacheEntities(entry, response.users, response.chats);
      return buildMessageSummaries(GramJs, undefined, response.messages, response.users, response.chats);
    } catch (err: unknown) {
      throw new Error(formatTelegramError(err, entry.gramjs));
    }
  }

  async sendMessage(
    account: StoredAccountRecord,
    params: SendMessageParams,
  ): Promise<{ messageId: number; chatId: string; date: number }> {
    const entry = await this.getOrConnectClient(account);
    const { Api: GramJs } = entry.gramjs;
    const peer = await this.resolveInputPeer(account, entry, params.chatId);

    try {
      const randomId = generateSignedRandomBigInt64();
      const response = await withTimeout(
        entry.client.invoke(new GramJs.messages.SendMessage({
          peer,
          message: params.text,
          randomId,
          replyTo: params.replyToMsgId
            ? new GramJs.InputReplyToMessage({ replyToMsgId: params.replyToMsgId })
            : undefined,
        })),
        REQUEST_TIMEOUT_MS,
      );

      let messageId = 0;
      let date = Math.floor(Date.now() / 1000);
      if (response instanceof GramJs.UpdateShortSentMessage) {
        messageId = response.id;
        date = response.date;
      } else if ('updates' in response && Array.isArray(response.updates)) {
        for (const update of response.updates) {
          if (update instanceof GramJs.UpdateMessageID) {
            messageId = update.id;
            break;
          }
          if (
            (update instanceof GramJs.UpdateNewMessage || update instanceof GramJs.UpdateNewChannelMessage)
            && update.message instanceof GramJs.Message
          ) {
            messageId = update.message.id;
            date = update.message.date;
            break;
          }
        }
      }

      return {
        messageId,
        chatId: params.chatId,
        date,
      };
    } catch (err: unknown) {
      throw new Error(formatTelegramError(err, entry.gramjs));
    }
  }

  async createGroup(
    account: StoredAccountRecord,
    params: CreateGroupParams,
  ): Promise<{ chatId: string; title: string }> {
    const entry = await this.getOrConnectClient(account);
    const { Api: GramJs } = entry.gramjs;
    if (!entry.inputUsers.size) {
      await this.listDialogs(account, { limit: 100 });
    }

    const users: Api.TypeInputUser[] = [];
    for (const userId of params.userIds) {
      const inputUser = entry.inputUsers.get(userId);
      if (!inputUser) {
        throw new Error(`Unable to resolve Telegram user "${userId}" in account contacts/dialogs`);
      }
      users.push(inputUser);
    }

    try {
      const response = await withTimeout(
        entry.client.invoke(new GramJs.messages.CreateChat({
          users,
          title: params.title,
        })),
        REQUEST_TIMEOUT_MS,
      );

      const createdChats = response.updates && 'chats' in response.updates ? response.updates.chats : [];
      const firstChat = createdChats.find((chat): chat is Api.Chat => chat instanceof GramJs.Chat);
      const chatId = firstChat ? `-${firstChat.id}` : 'unknown';

      if (createdChats.length) {
        this.cacheEntities(entry, [], createdChats);
      }

      return {
        chatId,
        title: firstChat?.title || params.title,
      };
    } catch (err: unknown) {
      throw new Error(formatTelegramError(err, entry.gramjs));
    }
  }

  async createChannel(
    account: StoredAccountRecord,
    params: CreateChannelParams,
  ): Promise<{ chatId: string; title: string; isMegagroup: boolean }> {
    const entry = await this.getOrConnectClient(account);
    const { Api: GramJs } = entry.gramjs;
    const isMegagroup = Boolean(params.isMegagroup);

    try {
      const response = await withTimeout(
        entry.client.invoke(new GramJs.channels.CreateChannel({
          title: params.title,
          about: params.about || '',
          broadcast: !isMegagroup || undefined,
          megagroup: isMegagroup || undefined,
        })),
        REQUEST_TIMEOUT_MS,
      );

      const chats = 'chats' in response ? response.chats : [];
      const firstChannel = chats.find((chat): chat is Api.Channel => chat instanceof GramJs.Channel);
      const chatId = firstChannel ? `-100${firstChannel.id}` : 'unknown';

      if (chats.length) {
        this.cacheEntities(entry, [], chats);
      }

      return {
        chatId,
        title: firstChannel?.title || params.title,
        isMegagroup,
      };
    } catch (err: unknown) {
      throw new Error(formatTelegramError(err, entry.gramjs));
    }
  }

  async markChatRead(
    account: StoredAccountRecord,
    params: MarkChatReadParams,
  ): Promise<{ chatId: string; maxId: number; affectedCount: number }> {
    const entry = await this.getOrConnectClient(account);
    const { Api: GramJs } = entry.gramjs;
    const peer = await this.resolveInputPeer(account, entry, params.chatId);
    const maxId = params.maxId || 0;

    try {
      if (peer instanceof GramJs.InputPeerChannel) {
        await withTimeout(
          entry.client.invoke(new GramJs.channels.ReadHistory({
            channel: new GramJs.InputChannel({
              channelId: peer.channelId,
              accessHash: peer.accessHash,
            }),
            maxId,
          })),
          REQUEST_TIMEOUT_MS,
        );
        return { chatId: params.chatId, maxId, affectedCount: 1 };
      }

      const result = await withTimeout(
        entry.client.invoke(new GramJs.messages.ReadHistory({
          peer,
          maxId,
        })),
        REQUEST_TIMEOUT_MS,
      );

      return {
        chatId: params.chatId,
        maxId,
        affectedCount: result.ptsCount || 0,
      };
    } catch (err: unknown) {
      throw new Error(formatTelegramError(err, entry.gramjs));
    }
  }

  async disconnectAccount(accountId: string): Promise<void> {
    const existing = this.clients.get(accountId);
    if (!existing) return;
    this.clients.delete(accountId);
    try {
      existing.client.destroy();
    } catch {
      // Ignore cleanup errors on already-closed sockets
    }
  }

  async shutdown(): Promise<void> {
    const ids = Array.from(this.clients.keys());
    await Promise.all(ids.map((id) => this.disconnectAccount(id)));
  }

  private async getOrConnectClient(account: StoredAccountRecord): Promise<ManagedClientEntry> {
    if (!this.apiId || !this.apiHash) {
      throw new Error('TELEGRAM_API_ID and TELEGRAM_API_HASH must be configured to connect via GramJS WSS');
    }

    const existing = this.clients.get(account.id);
    if (existing && existing.client.isConnected()) {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    if (existing) {
      await this.disconnectAccount(account.id);
    }

    const gramjs = await loadProjectGramJs();
    const session = new gramjs.sessions.CallbackSession(account.sessionData, () => undefined);
    const client = new gramjs.TelegramClient(session, this.apiId, this.apiHash, {
      deviceModel: 'Telegram Web Z MCP Manager',
      systemVersion: 'Node.js WSS',
      appVersion: '13.0.1 A-MCP',
      useWSS: true,
      langPack: 'weba',
      langCode: 'ar',
      systemLangCode: 'ar',
      dcId: account.mainDcId,
      isTestServerRequested: account.isTest,
      additionalDcsDisabled: true,
      autoReconnect: false,
      connectionRetries: 2,
      requestRetries: 1,
      floodSleepLimit: 0, // Never silently sleep/loop on FloodWait
    });

    await withTimeout(client.connect(), CONNECT_TIMEOUT_MS);

    const entry: ManagedClientEntry = {
      gramjs,
      client,
      inputPeers: new Map(),
      inputUsers: new Map(),
      lastUsedAt: Date.now(),
    };
    this.clients.set(account.id, entry);
    return entry;
  }

  private async resolveInputPeer(
    account: StoredAccountRecord,
    entry: ManagedClientEntry,
    chatId: string,
  ): Promise<Api.TypeInputPeer> {
    const { Api: GramJs } = entry.gramjs;
    const cached = entry.inputPeers.get(chatId);
    if (cached) return cached;

    if (account.profile.userId && chatId === account.profile.userId) {
      return new GramJs.InputPeerSelf();
    }

    // Refresh dialogs once to populate access hashes for channels and users
    await this.listDialogs(account, { limit: 100 });
    const refreshed = entry.inputPeers.get(chatId);
    if (refreshed) return refreshed;

    // Basic legacy group chats use negative IDs without -100 prefix and require no accessHash
    if (/^-\d+$/.test(chatId) && !chatId.startsWith('-100')) {
      return new GramJs.InputPeerChat({ chatId: BigInt(chatId.slice(1)) });
    }

    throw new Error(`Chat "${chatId}" could not be resolved for this account. Call list_dialogs first.`);
  }

  private cacheEntities(
    entry: ManagedClientEntry,
    users: Api.TypeUser[],
    chats: Api.TypeChat[],
  ) {
    const { Api: GramJs } = entry.gramjs;
    for (const user of users) {
      if (!(user instanceof GramJs.User)) continue;
      const id = String(user.id);
      if (user.self) {
        entry.inputPeers.set(id, new GramJs.InputPeerSelf());
        entry.inputUsers.set(id, new GramJs.InputUserSelf());
      } else if (user.accessHash !== undefined) {
        entry.inputPeers.set(id, new GramJs.InputPeerUser({ userId: user.id, accessHash: user.accessHash }));
        entry.inputUsers.set(id, new GramJs.InputUser({ userId: user.id, accessHash: user.accessHash }));
      }
    }

    for (const chat of chats) {
      if (chat instanceof GramJs.Chat) {
        entry.inputPeers.set(`-${chat.id}`, new GramJs.InputPeerChat({ chatId: chat.id }));
      } else if (chat instanceof GramJs.Channel && chat.accessHash !== undefined) {
        entry.inputPeers.set(
          `-100${chat.id}`,
          new GramJs.InputPeerChannel({ channelId: chat.id, accessHash: chat.accessHash }),
        );
      }
    }
  }
}

function extractChatIdFromPeer(GramJs: typeof Api, peer?: Api.TypePeer): string | undefined {
  if (!peer) return undefined;
  if (peer instanceof GramJs.PeerUser) return String(peer.userId);
  if (peer instanceof GramJs.PeerChat) return `-${peer.chatId}`;
  if (peer instanceof GramJs.PeerChannel) return `-100${peer.channelId}`;
  return undefined;
}

function resolvePeerSummary(
  GramJs: typeof Api,
  peer: Api.TypePeer,
  users: Map<string, Api.User>,
  chats: Map<string, Api.Chat | Api.Channel>,
): { title: string; type: DialogSummary['type']; username?: string } {
  if (peer instanceof GramJs.PeerUser) {
    const user = users.get(String(peer.userId));
    const title = user
      ? [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.username || String(user.id)
      : String(peer.userId);
    return { title, type: 'user', username: user?.username };
  }
  if (peer instanceof GramJs.PeerChat) {
    const chat = chats.get(String(peer.chatId));
    return {
      title: chat && 'title' in chat ? chat.title : `Group ${peer.chatId}`,
      type: 'group',
    };
  }
  if (peer instanceof GramJs.PeerChannel) {
    const channel = chats.get(String(peer.channelId));
    const isMegagroup = channel instanceof GramJs.Channel && Boolean(channel.megagroup);
    return {
      title: channel && 'title' in channel ? channel.title : `Channel ${peer.channelId}`,
      type: isMegagroup ? 'supergroup' : 'channel',
      username: channel instanceof GramJs.Channel ? channel.username : undefined,
    };
  }
  return { title: 'Unknown', type: 'user' };
}

function buildMessageSummaries(
  GramJs: typeof Api,
  fallbackChatId: string | undefined,
  messages: Api.TypeMessage[],
  users: Api.TypeUser[],
  chats: Api.TypeChat[],
): MessageSummary[] {
  const senderNames = new Map<string, string>();
  for (const user of users) {
    if (user instanceof GramJs.User) {
      const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.username || String(user.id);
      senderNames.set(String(user.id), name);
    }
  }
  for (const chat of chats) {
    if (chat instanceof GramJs.Chat) {
      senderNames.set(`-${chat.id}`, chat.title);
    } else if (chat instanceof GramJs.Channel) {
      senderNames.set(`-100${chat.id}`, chat.title);
    }
  }

  const summaries: MessageSummary[] = [];
  for (const msg of messages) {
    if (!(msg instanceof GramJs.Message)) continue;
    const chatId = extractChatIdFromPeer(GramJs, msg.peerId) || fallbackChatId || 'unknown';
    const senderId = extractChatIdFromPeer(GramJs, msg.fromId);
    const replyToMsgId = msg.replyTo instanceof GramJs.MessageReplyHeader ? msg.replyTo.replyToMsgId : undefined;

    summaries.push({
      id: msg.id,
      chatId,
      senderId,
      senderName: senderId ? senderNames.get(senderId) : undefined,
      date: msg.date,
      text: msg.message || '',
      isOutgoing: Boolean(msg.out),
      replyToMsgId,
    });
  }

  return summaries;
}

function formatTelegramError(err: unknown, gramjs?: GramJsRuntimeModule): string {
  if (gramjs) {
    if (err instanceof gramjs.errors.FloodWaitError) {
      return `FLOOD_WAIT_${err.seconds} (يرجى الانتظار ${err.seconds} ثانية دون إعادة المحاولة التلقائية)`;
    }
    if (err instanceof gramjs.errors.RPCError) {
      return err.errorMessage;
    }
  }
  if (err instanceof Error) {
    return err.message;
  }
  return 'Unknown Telegram WSS runtime error';
}

function generateSignedRandomBigInt64(): bigint {
  return randomBytes(8).readBigInt64BE(0);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Telegram WSS request timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
