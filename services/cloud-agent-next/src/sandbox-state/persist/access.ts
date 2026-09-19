/**
 * Storage access for the two aggregates. This is the only module that names the
 * two raw storage keys; every other module (including the canonical store and
 * loader) reaches them through the operations below, so C3/C4 can swap the
 * persisted shapes behind this seam without touching call sites.
 *
 * C2 keeps the current shapes: the flat allocation record and a bare
 * session-message array. `readRaw` always returns the stored records;
 * `readActive` returns none while the terminal lifecycle blocks the session.
 *
 * The `seed*`/`read*From` helpers exist for fixtures that hold a plain `Map` or
 * object instead of a storage adapter; they still go through this module.
 */
const ALLOCATION_RECORD_KEY = 'physical_record';
const SESSION_MESSAGES_KEY = 'session_messages';

export type AsyncRecordReader = {
  get(key: string): Promise<unknown>;
};

export type AsyncRecordWriter = {
  put(key: string, value: unknown): Promise<void>;
};

export type AsyncRecordEraser = {
  delete(keys: string[]): Promise<unknown>;
};

export type SyncRecordReader = {
  get(key: string): unknown;
};

export type SyncRecordWriter = {
  put(key: string, value: unknown): void;
};

export type SyncRecordEraser = {
  delete(key: string): unknown;
};

export type SeedRecords = Map<string, unknown> | Record<string, unknown>;

export type StoredEntry = {
  readonly key: string;
  readonly value: unknown;
};

export function isAllocationRecordKey(key: string): boolean {
  return key === ALLOCATION_RECORD_KEY;
}

export function isSessionMessagesKey(key: string): boolean {
  return key === SESSION_MESSAGES_KEY;
}

// --- allocation, current flat record (async) ---

export async function readAllocationEntry(
  storage: AsyncRecordReader
): Promise<StoredEntry | undefined> {
  const value = await storage.get(ALLOCATION_RECORD_KEY);
  return value === undefined ? undefined : { key: ALLOCATION_RECORD_KEY, value };
}

export async function readAllocationRecord<T = unknown>(
  storage: AsyncRecordReader
): Promise<T | undefined> {
  return (await readAllocationEntry(storage))?.value as T | undefined;
}

export async function writeAllocationRecord(
  storage: AsyncRecordWriter,
  record: unknown
): Promise<void> {
  await storage.put(ALLOCATION_RECORD_KEY, record);
}

/** Deletes the allocation record and the caller's keys in one atomic delete. */
export async function eraseAllocationRecord(
  storage: AsyncRecordEraser,
  additionalKeys: string[]
): Promise<void> {
  await storage.delete([ALLOCATION_RECORD_KEY, ...additionalKeys]);
}

// --- session, current bare array (sync) ---

export function readRawSessionMessages<T = unknown>(storage: SyncRecordReader): T[] {
  return (storage.get(SESSION_MESSAGES_KEY) as T[] | undefined) ?? [];
}

export function readActiveSessionMessages<T = unknown>(
  storage: SyncRecordReader,
  blocked: boolean
): T[] {
  return blocked ? [] : readRawSessionMessages<T>(storage);
}

export function writeSessionMessages(storage: SyncRecordWriter, messages: unknown[]): void {
  storage.put(SESSION_MESSAGES_KEY, messages);
}

export function readSessionValueSync<T = unknown>(storage: SyncRecordReader): T | undefined {
  return storage.get(SESSION_MESSAGES_KEY) as T | undefined;
}

export function writeSessionValueSync(storage: SyncRecordWriter, value: unknown): void {
  storage.put(SESSION_MESSAGES_KEY, value);
}

export function eraseSessionMessages(storage: SyncRecordEraser): void {
  storage.delete(SESSION_MESSAGES_KEY);
}

// --- session, raw value (async) ---

export async function readSessionEntry(
  storage: AsyncRecordReader
): Promise<StoredEntry | undefined> {
  const value = await storage.get(SESSION_MESSAGES_KEY);
  return value === undefined ? undefined : { key: SESSION_MESSAGES_KEY, value };
}

export async function readSessionValue<T = unknown>(
  storage: AsyncRecordReader
): Promise<T | undefined> {
  return (await readSessionEntry(storage))?.value as T | undefined;
}

export async function writeSessionValue(storage: AsyncRecordWriter, value: unknown): Promise<void> {
  await storage.put(SESSION_MESSAGES_KEY, value);
}

export async function eraseSessionValue(storage: AsyncRecordEraser): Promise<void> {
  await storage.delete([SESSION_MESSAGES_KEY]);
}

// --- fixtures backed by a plain Map or object ---

function seedInto(records: SeedRecords, key: string, value: unknown): void {
  if (records instanceof Map) records.set(key, value);
  else records[key] = value;
}

function readSeeded(records: SeedRecords, key: string): unknown {
  return records instanceof Map ? records.get(key) : records[key];
}

export function seedAllocationRecord<T extends SeedRecords>(records: T, record: unknown): T {
  seedInto(records, ALLOCATION_RECORD_KEY, record);
  return records;
}

export function seedSessionValue<T extends SeedRecords>(records: T, value: unknown): T {
  seedInto(records, SESSION_MESSAGES_KEY, value);
  return records;
}

export function readAllocationRecordFrom<T = unknown>(records: SeedRecords): T | undefined {
  return readSeeded(records, ALLOCATION_RECORD_KEY) as T | undefined;
}

export function readSessionMessagesFrom<T = unknown>(records: SeedRecords): T[] | undefined {
  return readSeeded(records, SESSION_MESSAGES_KEY) as T[] | undefined;
}

export function readSessionValueFrom(records: SeedRecords): unknown {
  return readSeeded(records, SESSION_MESSAGES_KEY);
}
