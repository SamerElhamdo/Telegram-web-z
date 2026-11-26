import { describe, expect, it } from 'vitest';

import {
  buildBridgePayloadFromWebZSlot,
  convertApiSessionToWebZSlot,
  convertLegacyStorageToApiSession,
  convertWebZSlotToApiSession,
  getWssEndpointForDc,
  maskPhoneNumber,
  redactSensitiveData,
  validateBridgePayload,
} from '../../src/shared/sessionBridge';

const DUMMY_KEY_DC2 = 'a1'.repeat(256); // 512 hex chars (256 bytes)
const DUMMY_KEY_DC4 = 'b2'.repeat(256);
const DUMMY_TEMP_KEY = 'c3'.repeat(256);

describe('Web Z <-> GramJS sessionBridge', () => {
  it('converts Web Z SharedSessionData to ApiSessionData and back cleanly', () => {
    const slotData = {
      dcId: 2,
      dc2_auth_key: DUMMY_KEY_DC2,
      dc4_auth_key: DUMMY_KEY_DC4,
      authKeyCreatedAt: { 2: 1700000000 },
      tempAuthKey: { key: DUMMY_TEMP_KEY, expiresAt: 1800000000 },
      userId: '123456789',
      firstName: 'أحمد',
      lastName: 'العتيبي',
      phone: '+966501234567',
    };

    const apiSession = convertWebZSlotToApiSession(slotData);
    expect(apiSession.mainDcId).toBe(2);
    expect(apiSession.keys[2]).toBe(DUMMY_KEY_DC2);
    expect(apiSession.keys[4]).toBe(DUMMY_KEY_DC4);
    expect(apiSession.tempAuthKey?.key).toBe(DUMMY_TEMP_KEY);

    const restoredSlot = convertApiSessionToWebZSlot(apiSession, {
      userId: '123456789',
      firstName: 'أحمد',
    });
    expect(restoredSlot.dcId).toBe(2);
    expect(restoredSlot.dc2_auth_key).toBe(DUMMY_KEY_DC2);
    expect(restoredSlot.dc4_auth_key).toBe(DUMMY_KEY_DC4);
    expect(restoredSlot.userId).toBe('123456789');
  });

  it('converts legacy Web Z localStorage keys (user_auth + quoted dc*_auth_key)', () => {
    const converted = convertLegacyStorageToApiSession({
      userAuthJson: JSON.stringify({ dcID: 4, id: 777111, test: true }),
      dc: '4',
      dcAuthKeys: {
        4: JSON.stringify(DUMMY_KEY_DC4),
      },
    });

    expect(converted.userId).toBe('777111');
    expect(converted.sessionData.mainDcId).toBe(4);
    expect(converted.sessionData.isTest).toBe(true);
    expect(converted.sessionData.keys[4]).toBe(DUMMY_KEY_DC4);
  });

  it('builds and validates bridge payload while masking phone number', () => {
    const payload = buildBridgePayloadFromWebZSlot(1, {
      dcId: 2,
      dc2_auth_key: DUMMY_KEY_DC2,
      userId: '555001',
      firstName: 'سارة',
      phone: '+966501234567',
    });

    const validated = validateBridgePayload(payload);
    expect(validated.version).toBe(1);
    expect(validated.slot).toBe(1);
    expect(validated.profile.phoneMasked).toBe('+966••••67');
    expect(maskPhoneNumber('+966501234567')).toBe('+966••••67');
  });

  it('rejects invalid DC IDs, malformed hex auth keys, and missing main DC key', () => {
    expect(() => convertWebZSlotToApiSession({
      dcId: 9,
      dc2_auth_key: DUMMY_KEY_DC2,
    })).toThrow(/unsupported main DC ID/i);

    expect(() => convertWebZSlotToApiSession({
      dcId: 2,
      dc2_auth_key: 'short-invalid-key',
    })).toThrow(/Invalid MTProto auth key/i);

    expect(() => convertWebZSlotToApiSession({
      dcId: 2,
      dc4_auth_key: DUMMY_KEY_DC4,
    })).toThrow(/Missing MTProto auth key for main DC 2/i);
  });

  it('builds exact Telegram Web Z WSS endpoints', () => {
    expect(getWssEndpointForDc(2)).toBe('wss://zws2.web.telegram.org:443/apiws');
    expect(getWssEndpointForDc(4, true)).toBe('wss://zws4.web.telegram.org:443/apiws_test');
    expect(getWssEndpointForDc(5, false, true)).toBe('wss://zws5.web.telegram.org:443/apiws_premium');
    expect(() => getWssEndpointForDc(99)).toThrow();
  });

  it('redacts sensitive fields and long hex strings from logs', () => {
    const redacted = redactSensitiveData({
      action: 'import',
      dc2_auth_key: DUMMY_KEY_DC2,
      apiHash: 'dummy-hash-value',
      authorization: 'Bearer secret',
      nested: {
        token: 'secret-token',
        safeField: 'visible',
        rawHex: DUMMY_KEY_DC4,
      },
    });

    expect(redacted.action).toBe('import');
    expect(redacted.dc2_auth_key).toBe('[REDACTED]');
    expect(redacted.apiHash).toBe('[REDACTED]');
    expect(redacted.authorization).toBe('[REDACTED]');
    expect(redacted.nested.token).toBe('[REDACTED]');
    expect(redacted.nested.safeField).toBe('visible');
    expect(redacted.nested.rawHex).toBe('[REDACTED_HEX]');
  });
});
