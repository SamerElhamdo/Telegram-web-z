export type BridgeDcId = 1 | 2 | 3 | 4 | 5;

const BRIDGE_DC_IDS: readonly BridgeDcId[] = [1, 2, 3, 4, 5];

export type BridgeApiSessionData = {
  mainDcId: number;
  keys: Record<number, string>;
  authKeyCreatedAt?: Record<number, number>;
  tempAuthKey?: {
    key: string;
    expiresAt: number;
  };
  isTest?: true;
};

export type BridgeSessionUserInfo = {
  userId?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  avatarUri?: string;
  color?: number;
  isPremium?: boolean;
  emojiStatusId?: string;
};

export type BridgeSharedSessionData = {
  pushKey?: string;
  date?: number;
  dcId: number;
  authKeyCreatedAt?: BridgeApiSessionData['authKeyCreatedAt'];
  tempAuthKey?: BridgeApiSessionData['tempAuthKey'];
  isTest?: true;
} & Partial<Record<`dc${BridgeDcId}_${'auth_key' | 'server_salt'}`, string>> & BridgeSessionUserInfo;

export type SentCodeDeliveryType =
  | 'SentCodeTypeApp'
  | 'SentCodeTypeSms'
  | 'SentCodeTypeCall'
  | 'SentCodeTypeFlashCall'
  | 'SentCodeTypeMissedCall'
  | 'SentCodeTypeEmailCode'
  | 'SentCodeTypeSetUpEmailRequired'
  | 'SentCodeTypeFragmentSms'
  | 'SentCodeTypeFirebaseSms'
  | 'SentCodeTypeSmsWord'
  | 'SentCodeTypeSmsPhrase'
  | 'SentCodeSuccess'
  | 'SentCodePaymentRequired'
  | 'Unknown';

export type SentCodeMetadata = {
  type: SentCodeDeliveryType;
  length?: number;
  nextType?: string;
  timeout?: number;
  emailPattern?: string;
  isPaymentRequired?: boolean;
};

export type BridgeAccountProfile = {
  userId?: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  phoneMasked?: string;
  isTest?: boolean;
};

export type BridgeSessionPayload = {
  version: 1;
  source: 'webz-slot' | 'webz-legacy' | 'gramjs-session';
  slot?: number;
  sessionData: BridgeApiSessionData;
  profile: BridgeAccountProfile;
  exportedAt: number;
};

export type LegacyWebZStorageSnapshot = {
  userAuthJson?: string;
  dc?: string;
  dcAuthKeys: Partial<Record<BridgeDcId, string>>;
};

const VALID_DC_ID_SET = new Set<number>(BRIDGE_DC_IDS);
const HEX_AUTH_KEY_LENGTH = 512; // 256 bytes MTProto permanent auth key
const HEX_PATTERN = /^[0-9a-f]+$/i;
const SENSITIVE_KEY_PATTERN = new RegExp(
  '(auth_?key|api_?hash|token|secret|password|cookie|authorization|sessiondata|tempauthkey|phonecode|keys)',
  'i',
);
const MIN_PHONE_VISIBLE_DIGITS = 4;
const MAX_SLOT_NUMBER = 16;

export function isValidDcId(dcId: unknown): dcId is BridgeDcId {
  return typeof dcId === 'number' && Number.isInteger(dcId) && VALID_DC_ID_SET.has(dcId);
}

export function isValidAuthKeyHex(value: unknown): value is string {
  return typeof value === 'string' && value.length === HEX_AUTH_KEY_LENGTH && HEX_PATTERN.test(value);
}

export function maskPhoneNumber(phone?: string): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.length <= MIN_PHONE_VISIBLE_DIGITS) {
    return '••••';
  }
  const prefix = digits.startsWith('+') ? digits.slice(0, 4) : digits.slice(0, 2);
  const suffix = digits.slice(-2);
  return `${prefix}••••${suffix}`;
}

export function getWssEndpointForDc(dcId: number, isTestServer = false, isPremium = false): string {
  if (!isValidDcId(dcId)) {
    throw new Error('Invalid Telegram data center ID');
  }
  return `wss://zws${dcId}.web.telegram.org:443/apiws${isTestServer ? '_test' : ''}${isPremium ? '_premium' : ''}`;
}

export function convertWebZSlotToApiSession(slotData: BridgeSharedSessionData): BridgeApiSessionData {
  if (!slotData || typeof slotData !== 'object') {
    throw new Error('Web Z slot session data is missing');
  }

  if (!isValidDcId(slotData.dcId)) {
    throw new Error('Web Z slot session has an unsupported main DC ID');
  }

  const keys: Record<number, string> = {};
  for (const dcId of BRIDGE_DC_IDS) {
    const rawKey = slotData[`dc${dcId}_auth_key` as const];
    if (rawKey === undefined) continue;
    const normalized = stripSurroundingJsonQuotes(rawKey);
    if (!isValidAuthKeyHex(normalized)) {
      throw new Error(`Invalid MTProto auth key format for DC ${dcId}`);
    }
    keys[dcId] = normalized.toLowerCase();
  }

  if (!keys[slotData.dcId]) {
    throw new Error(`Missing MTProto auth key for main DC ${slotData.dcId}`);
  }

  const tempAuthKey = validateTempAuthKey(slotData.tempAuthKey);
  const authKeyCreatedAt = sanitizeAuthKeyCreatedAt(slotData.authKeyCreatedAt);

  return {
    mainDcId: slotData.dcId,
    keys,
    authKeyCreatedAt,
    tempAuthKey,
    isTest: slotData.isTest ? true : undefined,
  };
}

export function convertLegacyStorageToApiSession(
  snapshot: LegacyWebZStorageSnapshot,
): { sessionData: BridgeApiSessionData; userId?: string } {
  let parsedUserAuth: { dcID?: number; id?: string | number; test?: boolean } | undefined;
  if (snapshot.userAuthJson) {
    try {
      parsedUserAuth = JSON.parse(snapshot.userAuthJson) as { dcID?: number; id?: string | number; test?: boolean };
    } catch {
      throw new Error('Legacy user_auth JSON is invalid');
    }
  }

  const mainDcId = Number(parsedUserAuth?.dcID ?? snapshot.dc);
  if (!isValidDcId(mainDcId)) {
    throw new Error('Legacy Web Z session has an unsupported main DC ID');
  }

  const keys: Record<number, string> = {};
  for (const dcId of BRIDGE_DC_IDS) {
    const rawValue = snapshot.dcAuthKeys[dcId];
    if (!rawValue) continue;
    const normalized = stripSurroundingJsonQuotes(rawValue);
    if (!isValidAuthKeyHex(normalized)) {
      throw new Error(`Invalid legacy MTProto auth key format for DC ${dcId}`);
    }
    keys[dcId] = normalized.toLowerCase();
  }

  if (!keys[mainDcId]) {
    throw new Error(`Missing legacy MTProto auth key for main DC ${mainDcId}`);
  }

  return {
    sessionData: {
      mainDcId,
      keys,
      isTest: parsedUserAuth?.test ? true : undefined,
    },
    userId: parsedUserAuth?.id !== undefined ? String(parsedUserAuth.id) : undefined,
  };
}

export function convertApiSessionToWebZSlot(
  sessionData: BridgeApiSessionData,
  profile?: BridgeSessionUserInfo,
): BridgeSharedSessionData {
  if (!isValidDcId(sessionData.mainDcId)) {
    throw new Error('Session data has an unsupported main DC ID');
  }

  const slotData: BridgeSharedSessionData = {
    dcId: sessionData.mainDcId,
    authKeyCreatedAt: sanitizeAuthKeyCreatedAt(sessionData.authKeyCreatedAt),
    tempAuthKey: validateTempAuthKey(sessionData.tempAuthKey),
    isTest: sessionData.isTest ? true : undefined,
    userId: profile?.userId,
    firstName: profile?.firstName,
    lastName: profile?.lastName,
    phone: profile?.phone,
    avatarUri: profile?.avatarUri,
    color: profile?.color,
    isPremium: profile?.isPremium,
    emojiStatusId: profile?.emojiStatusId,
  };

  for (const dcId of BRIDGE_DC_IDS) {
    const key = sessionData.keys[dcId];
    if (key === undefined) continue;
    if (!isValidAuthKeyHex(key)) {
      throw new Error(`Invalid MTProto auth key format for DC ${dcId}`);
    }
    slotData[`dc${dcId}_auth_key` as const] = key.toLowerCase();
  }

  if (!slotData[`dc${sessionData.mainDcId}_auth_key` as const]) {
    throw new Error(`Missing MTProto auth key for main DC ${sessionData.mainDcId}`);
  }

  return slotData;
}

export function buildBridgePayloadFromWebZSlot(
  slot: number,
  slotData: BridgeSharedSessionData,
  username?: string,
): BridgeSessionPayload {
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SLOT_NUMBER) {
    throw new Error('Invalid Web Z account slot number');
  }

  const sessionData = convertWebZSlotToApiSession(slotData);

  return {
    version: 1,
    source: 'webz-slot',
    slot,
    sessionData,
    profile: {
      userId: slotData.userId ? String(slotData.userId) : undefined,
      firstName: slotData.firstName,
      lastName: slotData.lastName,
      username,
      phoneMasked: maskPhoneNumber(slotData.phone),
      isTest: Boolean(sessionData.isTest),
    },
    exportedAt: Date.now(),
  };
}

export function validateBridgePayload(input: unknown): BridgeSessionPayload {
  if (!input || typeof input !== 'object') {
    throw new Error('Session bridge payload must be an object');
  }

  const record = input as Record<string, unknown>;
  if (record.version !== 1) {
    throw new Error('Unsupported session bridge payload version');
  }

  const source = record.source;
  if (source !== 'webz-slot' && source !== 'webz-legacy' && source !== 'gramjs-session') {
    throw new Error('Unsupported session bridge source');
  }

  const slot = record.slot;
  const isInvalidSlot = slot !== undefined
    && (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 1 || slot > MAX_SLOT_NUMBER);
  if (isInvalidSlot) {
    throw new Error('Invalid session bridge slot number');
  }

  const rawSession = record.sessionData as BridgeApiSessionData | undefined;
  if (!rawSession || typeof rawSession !== 'object') {
    throw new Error('Session bridge payload is missing sessionData');
  }

  if (!isValidDcId(rawSession.mainDcId)) {
    throw new Error('Invalid mainDcId in sessionData');
  }

  const keysRecord = rawSession.keys as Record<string, unknown> | undefined;
  if (!keysRecord || typeof keysRecord !== 'object') {
    throw new Error('Missing auth keys map in sessionData');
  }

  const cleanKeys: Record<number, string> = {};
  for (const [dcKey, keyValue] of Object.entries(keysRecord)) {
    const dcId = Number(dcKey);
    if (!isValidDcId(dcId)) {
      throw new Error('Invalid DC key inside sessionData.keys');
    }
    if (!isValidAuthKeyHex(keyValue)) {
      throw new Error(`Invalid MTProto auth key format for DC ${dcId}`);
    }
    cleanKeys[dcId] = keyValue.toLowerCase();
  }

  if (!cleanKeys[rawSession.mainDcId]) {
    throw new Error(`Missing MTProto auth key for main DC ${rawSession.mainDcId}`);
  }

  const rawProfile = (record.profile && typeof record.profile === 'object')
    ? record.profile as Record<string, unknown>
    : {};

  const profile: BridgeAccountProfile = {
    userId: typeof rawProfile.userId === 'string' ? rawProfile.userId.slice(0, 64) : undefined,
    firstName: typeof rawProfile.firstName === 'string' ? rawProfile.firstName.slice(0, 128) : undefined,
    lastName: typeof rawProfile.lastName === 'string' ? rawProfile.lastName.slice(0, 128) : undefined,
    username: typeof rawProfile.username === 'string' ? rawProfile.username.slice(0, 64) : undefined,
    phoneMasked: typeof rawProfile.phoneMasked === 'string' ? rawProfile.phoneMasked.slice(0, 32) : undefined,
    isTest: Boolean(rawSession.isTest),
  };

  const exportedAt = typeof record.exportedAt === 'number' && Number.isFinite(record.exportedAt)
    ? record.exportedAt
    : Date.now();

  return {
    version: 1,
    source,
    slot,
    sessionData: {
      mainDcId: rawSession.mainDcId,
      keys: cleanKeys,
      authKeyCreatedAt: sanitizeAuthKeyCreatedAt(rawSession.authKeyCreatedAt),
      tempAuthKey: validateTempAuthKey(rawSession.tempAuthKey),
      isTest: rawSession.isTest ? true : undefined,
    },
    profile,
    exportedAt,
  };
}

export function redactSensitiveData<T>(value: T): T {
  if (typeof value === 'string') {
    if (HEX_PATTERN.test(value) && value.length >= 64) {
      return '[REDACTED_HEX]' as T;
    }
    return value;
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveData(item)) as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = redactSensitiveData(entryValue);
    }
  }

  return result as T;
}

function stripSurroundingJsonQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') {
        return parsed.trim();
      }
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function sanitizeAuthKeyCreatedAt(
  value?: Record<number, number>,
): Record<number, number> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const cleaned: Record<number, number> = {};
  let hasEntry = false;
  for (const [dcStr, ts] of Object.entries(value)) {
    const dcId = Number(dcStr);
    if (isValidDcId(dcId) && typeof ts === 'number' && Number.isFinite(ts) && ts > 0) {
      cleaned[dcId] = ts;
      hasEntry = true;
    }
  }
  return hasEntry ? cleaned : undefined;
}

function validateTempAuthKey(
  value?: BridgeApiSessionData['tempAuthKey'],
): BridgeApiSessionData['tempAuthKey'] | undefined {
  if (!value) return undefined;
  if (
    typeof value !== 'object'
    || !isValidAuthKeyHex(value.key)
    || typeof value.expiresAt !== 'number'
    || !Number.isFinite(value.expiresAt)
  ) {
    throw new Error('Invalid temporary auth key format');
  }
  return {
    key: value.key.toLowerCase(),
    expiresAt: value.expiresAt,
  };
}
