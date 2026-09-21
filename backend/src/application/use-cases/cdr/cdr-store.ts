import { Db } from 'mongodb';

// ── Unified Call Detail Records ──────────────────────────────────────────
//
// A synced, queryable index over the REAL source systems (Asterisk's own
// CDR CSVs today; Kamailio's own `acc` DB table once Phase 3 lands) — not a
// competing primary store. Same distinction CLAUDE.md pattern #12 already
// draws for Traffic History vs. Prometheus: the source systems are the
// source of truth, this collection just makes them filterable/sortable/
// paginated in one place. Deliberately Mongo-backed (not re-derived from the
// CSVs on every request) for the same reason Twamp History is
// (twamp-history.ts) — per-feature configurable retention via a TTL index,
// and fast pagination over a dataset that only ever grows.

export const CDR_COLLECTION = 'nms_cdr';
export const DEFAULT_CDR_RETENTION_DAYS = 180;
export const MIN_CDR_RETENTION_DAYS = 1;
export const MAX_CDR_RETENTION_DAYS = 3650;

export type CdrSourceSystem = 'pstn' | '2g' | 'ims';
export type CdrSourceInstance = 'pstn' | 'asterisk2g' | 'scscf';
export type CdrDisposition = 'answered' | 'no-answer' | 'busy' | 'failed' | 'cancelled' | 'unknown';

export interface CdrParty {
  raw: string;
  imsi?: string;
  msisdn?: string;
  nickname?: string;
}

export interface CdrDocument {
  _id?: unknown;
  sourceSystem: CdrSourceSystem;
  sourceInstance: CdrSourceInstance;
  sourceRecordId: string; // Asterisk uniqueid, or (Phase 3) Kamailio Call-ID — the dedupe key
  caller: CdrParty;
  callee: CdrParty;
  startTime: Date;
  answerTime: Date | null;
  endTime: Date | null;
  durationSeconds: number | null;      // talk time (end - answer), matches Asterisk's "billsec"
  totalDurationSeconds: number | null; // end - start, matches Asterisk's "duration"
  disposition: CdrDisposition;
  rawDisposition: string;
  // Only meaningful for sourceSystem 'pstn' — distinguishes a real external
  // DID/trunk call (PSTN Gateway's new external-trunk feature) from every
  // other PSTN Gateway call (internal short codes, auto-dialed subscriber
  // MSISDNs, Cross-RAN forwarding). Derived from Asterisk's own accountcode
  // field (see cdr-sync-monitor.ts's parseAsteriskCsvRow()) — additive,
  // absent on every row synced before this field existed and on every
  // non-'pstn' row, never backfilled.
  trunkType?: 'internal' | 'external-did';
  raw: Record<string, unknown>;
  syncedAt: Date;
}

export interface CdrQueryFilter {
  from?: Date;
  to?: Date;
  sourceSystem?: CdrSourceSystem;
  imsi?: string;
  disposition?: CdrDisposition;
  page?: number;
  pageSize?: number;
}

export interface CdrQueryResult {
  rows: CdrDocument[];
  total: number;
  page: number;
  pageSize: number;
}

function col(db: Db) {
  return db.collection<CdrDocument>(CDR_COLLECTION);
}

// Idempotent — safe on every backend startup and every retention-setting
// change, same shape as twamp-history.ts's ensureHistoryIndexes().
export async function ensureCdrIndexes(db: Db, retentionDays: number): Promise<void> {
  const c = col(db);
  const seconds = Math.max(1, Math.round(retentionDays * 86400));
  const indexes = await c.indexes().catch(() => [] as any[]);

  const ttlIndex = indexes.find((ix: any) => ix.key && Object.keys(ix.key).length === 1 && ix.key.startTime === 1 && ix.expireAfterSeconds !== undefined);
  if (!ttlIndex) {
    await c.createIndex({ startTime: 1 }, { expireAfterSeconds: seconds });
  } else if (ttlIndex.expireAfterSeconds !== seconds) {
    await db.command({ collMod: CDR_COLLECTION, index: { keyPattern: { startTime: 1 }, expireAfterSeconds: seconds } });
  }

  const dedupeIndex = indexes.find((ix: any) => ix.key && ix.key.sourceInstance === 1 && ix.key.sourceRecordId === 1);
  if (!dedupeIndex) {
    await c.createIndex({ sourceInstance: 1, sourceRecordId: 1 }, { unique: true });
  }

  const listIndex = indexes.find((ix: any) => ix.key && ix.key.startTime === -1 && ix.key.sourceSystem === 1);
  if (!listIndex) {
    await c.createIndex({ startTime: -1, sourceSystem: 1 });
  }

  const callerIndex = indexes.find((ix: any) => ix.key && ix.key['caller.imsi'] === 1);
  if (!callerIndex) {
    await c.createIndex({ 'caller.imsi': 1, startTime: -1 });
  }
  const calleeIndex = indexes.find((ix: any) => ix.key && ix.key['callee.imsi'] === 1);
  if (!calleeIndex) {
    await c.createIndex({ 'callee.imsi': 1, startTime: -1 });
  }
}

// Natural-key upsert — safe to re-run the sync job over the same source
// records any number of times (e.g. after a backend restart re-reads a CSV
// offset that turns out to overlap already-synced rows).
export async function upsertCdr(db: Db, doc: CdrDocument): Promise<void> {
  await col(db).updateOne(
    { sourceInstance: doc.sourceInstance, sourceRecordId: doc.sourceRecordId },
    { $set: doc },
    { upsert: true },
  );
}

export async function queryCdrs(db: Db, filter: CdrQueryFilter): Promise<CdrQueryResult> {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filter.pageSize ?? 50));

  const match: Record<string, unknown> = {};
  if (filter.from || filter.to) {
    match.startTime = {
      ...(filter.from ? { $gte: filter.from } : {}),
      ...(filter.to ? { $lte: filter.to } : {}),
    };
  }
  if (filter.sourceSystem) match.sourceSystem = filter.sourceSystem;
  if (filter.disposition) match.disposition = filter.disposition;
  if (filter.imsi) {
    match.$or = [{ 'caller.imsi': filter.imsi }, { 'callee.imsi': filter.imsi }];
  }

  const c = col(db);
  const [rows, total] = await Promise.all([
    c.find(match).sort({ startTime: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
    c.countDocuments(match),
  ]);

  return { rows, total, page, pageSize };
}
