import { IdempotencyStore } from './types';

interface StoreEntry {
  value: unknown;
  expiresAt?: number;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly store: Map<string, StoreEntry> = new Map();

  async has(key: string): Promise<boolean> {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  async get(key: string): Promise<unknown | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    const entry: StoreEntry = { value };
    if (ttlMs !== undefined) {
      entry.expiresAt = Date.now() + ttlMs;
    }
    this.store.set(key, entry);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}
