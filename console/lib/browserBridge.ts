import type {
  BridgeSessionPayload,
  BridgeSharedSessionData,
  SentCodeMetadata,
} from '../../src/shared/sessionBridge';

import {
  buildBridgePayloadFromWebZSlot,
  convertLegacyStorageToApiSession,
  getWssEndpointForDc,
  isValidDcId,
  maskPhoneNumber,
} from '../../src/shared/sessionBridge';

export type BrowserSlotSummary = {
  slot: number;
  source: 'webz-slot' | 'webz-legacy';
  mainDcId: number;
  wssEndpoint: string;
  isTest: boolean;
  userId?: string;
  displayName: string;
  phoneMasked?: string;
  hasMainDcKey: boolean;
};

export type BrowserAuthDiagnostics = {
  connectionState?: string;
  authState?: string;
  sentCodeInfo?: SentCodeMetadata;
  floodWaitUntil?: number;
  errorCode?: string;
  isTestServer?: boolean;
  updatedAt?: number;
};

const SLOT_PREFIX = 'account';
const DIAGNOSTICS_KEY = 'tg_console_auth_diagnostics';
const DC_LIST = [1, 2, 3, 4, 5] as const;

// Reads only non-secret slot metadata from Web Z browser storage for display in UI
export function detectLocalWebZSlots(): BrowserSlotSummary[] {
  if (typeof localStorage === 'undefined') return [];

  const found: BrowserSlotSummary[] = [];
  const seenSlots = new Set<number>();

  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(SLOT_PREFIX)) continue;

    const slot = Number(key.slice(SLOT_PREFIX.length));
    if (!Number.isInteger(slot) || slot < 1 || slot > 16) continue;

    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as BridgeSharedSessionData;
      if (!isValidDcId(parsed.dcId)) continue;

      const mainKey = parsed[`dc${parsed.dcId}_auth_key` as const];
      const fullName = [parsed.firstName, parsed.lastName].filter(Boolean).join(' ').trim();
      found.push({
        slot,
        source: 'webz-slot',
        mainDcId: parsed.dcId,
        wssEndpoint: getWssEndpointForDc(parsed.dcId, Boolean(parsed.isTest)),
        isTest: Boolean(parsed.isTest),
        userId: parsed.userId ? String(parsed.userId) : undefined,
        displayName: fullName || (parsed.userId ? `حساب #${parsed.userId}` : `جلسة المتصفح #${slot}`),
        phoneMasked: maskPhoneNumber(parsed.phone),
        hasMainDcKey: typeof mainKey === 'string' && mainKey.length >= 512,
      });
      seenSlots.add(slot);
    } catch {
      // Ignore malformed localStorage items
    }
  }

  // Fallback check for legacy slot 1 keys (`user_auth` + `dc*_auth_key`)
  if (!seenSlots.has(1)) {
    const userAuthJson = localStorage.getItem('user_auth') || undefined;
    const dc = localStorage.getItem('dc') || undefined;
    const dcAuthKeys: Partial<Record<1 | 2 | 3 | 4 | 5, string>> = {};
    for (const dcId of DC_LIST) {
      const value = localStorage.getItem(`dc${dcId}_auth_key`);
      if (value) dcAuthKeys[dcId] = value;
    }

    if (userAuthJson || dc) {
      try {
        const legacy = convertLegacyStorageToApiSession({ userAuthJson, dc, dcAuthKeys });
        found.push({
          slot: 1,
          source: 'webz-legacy',
          mainDcId: legacy.sessionData.mainDcId,
          wssEndpoint: getWssEndpointForDc(legacy.sessionData.mainDcId, Boolean(legacy.sessionData.isTest)),
          isTest: Boolean(legacy.sessionData.isTest),
          userId: legacy.userId,
          displayName: legacy.userId ? `حساب #${legacy.userId}` : 'جلسة Web Z (الافتراضية)',
          hasMainDcKey: true,
        });
      } catch {
        // Legacy keys incomplete
      }
    }
  }

  return found.sort((a, b) => a.slot - b.slot);
}

// Explicit user-triggered export to bridge a browser session to the encrypted server vault
export function buildLocalSlotBridgePayload(slot: number): BridgeSessionPayload {
  const raw = localStorage.getItem(`${SLOT_PREFIX}${slot}`);
  if (raw) {
    const parsed = JSON.parse(raw) as BridgeSharedSessionData;
    return buildBridgePayloadFromWebZSlot(slot, parsed);
  }

  if (slot === 1) {
    const userAuthJson = localStorage.getItem('user_auth') || undefined;
    const dc = localStorage.getItem('dc') || undefined;
    const dcAuthKeys: Partial<Record<1 | 2 | 3 | 4 | 5, string>> = {};
    for (const dcId of DC_LIST) {
      const value = localStorage.getItem(`dc${dcId}_auth_key`);
      if (value) dcAuthKeys[dcId] = value;
    }
    const legacy = convertLegacyStorageToApiSession({ userAuthJson, dc, dcAuthKeys });
    return {
      version: 1,
      source: 'webz-legacy',
      slot: 1,
      sessionData: legacy.sessionData,
      profile: {
        userId: legacy.userId,
        isTest: Boolean(legacy.sessionData.isTest),
      },
      exportedAt: Date.now(),
    };
  }

  throw new Error(`لم يتم العثور على جلسة محلية في الخانة #${slot}`);
}

export function clearLocalWebZSlot(slot: number) {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(`${SLOT_PREFIX}${slot}`);
  if (slot === 1) {
    localStorage.removeItem('user_auth');
    localStorage.removeItem('dc');
    for (const dcId of DC_LIST) {
      localStorage.removeItem(`dc${dcId}_auth_key`);
      localStorage.removeItem(`dc${dcId}_hash`);
      localStorage.removeItem(`dc${dcId}_server_salt`);
    }
  }
}

export function readBrowserAuthDiagnostics(): BrowserAuthDiagnostics | undefined {
  if (typeof sessionStorage === 'undefined') return undefined;
  try {
    const raw = sessionStorage.getItem(DIAGNOSTICS_KEY);
    if (!raw) return undefined;
    return JSON.parse(raw) as BrowserAuthDiagnostics;
  } catch {
    return undefined;
  }
}
