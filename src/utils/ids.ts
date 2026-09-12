import { randomUUID } from 'node:crypto';

export function newId(prefix = 'id'): string {
  return `${prefix}_${randomUUID()}`;
}

export const nowMs = (): number => Date.now();
