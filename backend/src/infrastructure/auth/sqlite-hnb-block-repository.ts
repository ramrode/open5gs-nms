import type { Database } from 'better-sqlite3';

interface HnbBlockRow {
  ip: string;
  blocked_by: string;
  blocked_at: number;
}

export interface HnbBlockInfo {
  ip: string;
  blockedBy: string;
  blockedAt: number;
}

export class SqliteHnbBlockRepository {
  constructor(private readonly db: Database) {}

  getAll(): HnbBlockInfo[] {
    const rows = this.db
      .prepare('SELECT ip, blocked_by, blocked_at FROM hnb_blocks ORDER BY ip')
      .all() as HnbBlockRow[];
    return rows.map(r => ({ ip: r.ip, blockedBy: r.blocked_by, blockedAt: r.blocked_at }));
  }

  add(ip: string, blockedBy: string): void {
    this.db
      .prepare(
        `INSERT INTO hnb_blocks (ip, blocked_by, blocked_at)
         VALUES (?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET blocked_by = excluded.blocked_by, blocked_at = excluded.blocked_at`,
      )
      .run(ip, blockedBy, Date.now());
  }

  remove(ip: string): void {
    this.db.prepare('DELETE FROM hnb_blocks WHERE ip = ?').run(ip);
  }
}
