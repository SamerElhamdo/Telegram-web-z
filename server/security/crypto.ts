import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export type EncryptedEnvelope = {
  version: 1;
  alg: 'aes-256-gcm';
  iv: string;
  tag: string;
  ciphertext: string;
};

const AES_GCM_IV_BYTES = 12;
const AES_KEY_BYTES = 32;
const VAULT_AAD = Buffer.from('telegram-web-z-session-vault-v1', 'utf8');
const KEY_DERIVATION_DOMAIN = 'telegram-web-z:session-vault-aes-256-gcm:v1:';
const HEX_32_BYTES_RE = /^[0-9a-f]{64}$/i;

export function deriveAes256Key(secret: string): Buffer {
  const trimmed = secret.trim();
  if (!trimmed) {
    throw new Error('Encryption key secret cannot be empty');
  }

  if (HEX_32_BYTES_RE.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  const base64Candidate = Buffer.from(trimmed, 'base64');
  if (base64Candidate.length === AES_KEY_BYTES && base64Candidate.toString('base64') === trimmed) {
    return base64Candidate;
  }

  return createHash('sha256')
    .update(KEY_DERIVATION_DOMAIN, 'utf8')
    .update(trimmed, 'utf8')
    .digest();
}

export function encryptJson<T>(data: T, key: Buffer): EncryptedEnvelope {
  if (key.length !== AES_KEY_BYTES) {
    throw new Error('AES-256-GCM requires a 32-byte key');
  }

  const iv = randomBytes(AES_GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(VAULT_AAD);

  const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: encrypted.toString('base64'),
  };
}

export function decryptJson<T>(envelope: EncryptedEnvelope, key: Buffer): T {
  if (key.length !== AES_KEY_BYTES) {
    throw new Error('AES-256-GCM requires a 32-byte key');
  }

  if (!envelope || envelope.version !== 1 || envelope.alg !== 'aes-256-gcm') {
    throw new Error('Unsupported encrypted vault envelope format');
  }

  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(VAULT_AAD);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8')) as T;
}

export function hashSecretToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function verifyTokenAgainstHashes(candidate: string | undefined, expectedHashes: string[]): boolean {
  if (!candidate || !expectedHashes.length) {
    return false;
  }

  const candidateHashBuf = Buffer.from(hashSecretToken(candidate), 'hex');
  let isMatch = false;

  for (const expectedHex of expectedHashes) {
    if (!expectedHex || expectedHex.length !== 64) continue;
    const expectedBuf = Buffer.from(expectedHex, 'hex');
    if (expectedBuf.length === candidateHashBuf.length && timingSafeEqual(candidateHashBuf, expectedBuf)) {
      isMatch = true;
    }
  }

  return isMatch;
}

export function generateStrongToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function createSignedSessionCookie(
  payload: { ownerId: string; issuedAt: number; csrfToken: string },
  signingKey: Buffer,
): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', signingKey).update(encoded, 'utf8').digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifySignedSessionCookie(
  cookieValue: string | undefined,
  signingKey: Buffer,
  maxAgeMs: number,
): { ownerId: string; issuedAt: number; csrfToken: string } | undefined {
  if (!cookieValue) return undefined;
  const parts = cookieValue.split('.');
  if (parts.length !== 2) return undefined;

  const [encoded, providedSig] = parts;
  const expectedSig = createHmac('sha256', signingKey).update(encoded, 'utf8').digest('base64url');

  const providedBuf = Buffer.from(providedSig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      ownerId?: unknown;
      issuedAt?: unknown;
      csrfToken?: unknown;
    };
    if (
      typeof parsed.ownerId !== 'string'
      || typeof parsed.issuedAt !== 'number'
      || typeof parsed.csrfToken !== 'string'
    ) {
      return undefined;
    }
    if (Date.now() - parsed.issuedAt > maxAgeMs) {
      return undefined;
    }
    return {
      ownerId: parsed.ownerId,
      issuedAt: parsed.issuedAt,
      csrfToken: parsed.csrfToken,
    };
  } catch {
    return undefined;
  }
}

export function verifyConstantTimeString(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export function computeCanonicalPayloadHash(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value !== 'object' || !value) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryVal]) => entryVal !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
