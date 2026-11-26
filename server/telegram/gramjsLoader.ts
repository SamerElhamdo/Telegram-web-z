import type Api from '../../src/lib/gramjs/tl/api';
import type { BridgeApiSessionData } from '../../src/shared/sessionBridge';

export type GramJsClientInstance = {
  connect(): Promise<void>;
  isConnected(): boolean;
  destroy(): void;
  invoke<T extends Api.AnyRequest>(request: T): Promise<T['__response']>;
};

export type GramJsRuntimeModule = {
  Api: typeof Api;
  errors: {
    RPCError: new (...args: never[]) => Error & { errorMessage: string; code: number };
    FloodWaitError: new (...args: never[]) => Error & { seconds: number; errorMessage: string };
  };
  sessions: {
    CallbackSession: new (
      sessionData: BridgeApiSessionData | undefined,
      callback: (session?: BridgeApiSessionData) => void,
    ) => unknown;
  };
  TelegramClient: new (
    session: unknown,
    apiId: number,
    apiHash: string,
    opts?: Record<string, unknown>,
  ) => GramJsClientInstance;
};

let cachedGramJsPromise: Promise<GramJsRuntimeModule> | undefined;

export function loadProjectGramJs(): Promise<GramJsRuntimeModule> {
  if (!cachedGramJsPromise) {
    const modulePath = '../../src/lib/gramjs/index.ts';
    cachedGramJsPromise = import(modulePath) as Promise<GramJsRuntimeModule>;
  }
  return cachedGramJsPromise;
}
