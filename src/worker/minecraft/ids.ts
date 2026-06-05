import { randomHex } from '../crypto';

const MAX_SERVER_ID_LENGTH = 59;
const RANDOM_SUFFIX_LENGTH = 10;
const DEFAULT_SERVER_ID_PREFIX = 'minecraft-server';

export function createServerId(name: string | undefined): string {
  const suffix = randomHex(RANDOM_SUFFIX_LENGTH / 2);
  const baseLimit = MAX_SERVER_ID_LENGTH - suffix.length - 1;
  const base = toDnsLabel(name).slice(0, baseLimit).replace(/-+$/g, '') || DEFAULT_SERVER_ID_PREFIX;
  return `${base}-${suffix}`;
}

export function toDnsLabel(value: string | undefined): string {
  return (value ?? DEFAULT_SERVER_ID_PREFIX)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, MAX_SERVER_ID_LENGTH);
}

