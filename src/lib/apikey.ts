import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const API_KEY_PREFIX = 'awxs_';

export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function verifyApiKey(key: string, storedHash: string): boolean {
  const keyHash = Buffer.from(hashApiKey(key), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  if (keyHash.length !== stored.length) return false;
  return timingSafeEqual(keyHash, stored);
}
