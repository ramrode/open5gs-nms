/**
 * Per-HNB Iuh block via nftables — the 3G equivalent of radio-block-service.ts's
 * 4G S1-MME/S1-U block and gnb-block-service.ts's 5G N2/N3 block. Only ONE port
 * to block here, not two: unlike 4G/5G (separate control-plane and user-plane
 * interfaces straight to the radio), a real HNB's only path to this host is the
 * single Iuh SCTP association to HNBGW — actual CS/PS user data rides inside
 * that same RUA/RANAP-wrapped association, then goes on to osmo-msc/osmo-sgsn
 * over IuCS/IuPS, which never touches the HNB directly. Severing Iuh alone
 * fully cuts the HNB off.
 *
 * Unlike S1AP (36412) and NGAP (38412), Iuh's port is NOT a fixed 3GPP-standard
 * value pinned in this codebase — hnbgw-controller.ts's own HnbgwState.iuhLocalPort
 * is operator-configurable (default 29169), so this service can't hardcode it as
 * a module constant the way the 4G/5G versions do. Rule comments encode the port
 * a rule was actually written for (`hnb_block_<ip>_<port>`), and reconcile()
 * treats ip+port as the identity of a rule — so if the operator changes
 * iuhLocalPort while a block is active, the old-port rule naturally falls out of
 * the "desired" set (computed against the CURRENT port) and gets removed, while
 * a fresh rule is added on the new port. Without this, a stale rule on an
 * abandoned port would silently block nothing while still looking like an
 * active block.
 *
 * Own dedicated nftables table (`inet open5gs_nms_hnb_block`), per CLAUDE.md
 * pattern #11 ("give it its own table rather than sharing this one") — never
 * reuses open5gs_nms_radio_block or open5gs_nms_gnb_block.
 *
 * Desired state persisted in SQLite (hnb_blocks table) for the same reason as
 * the 4G/5G versions: nftables rules live only in the kernel and are wiped on
 * reboot, so a reconcile loop re-applies blocks that should still be active.
 */

import pino from 'pino';
import { IHostExecutor } from '../../../domain/interfaces/host-executor';
import { SqliteHnbBlockRepository } from '../../../infrastructure/auth/sqlite-hnb-block-repository';

const TABLE = 'open5gs_nms_hnb_block';
const CHAIN_IN = 'hnb_block_in';
const CHAIN_OUT = 'hnb_block_out';

function commentFor(ip: string, port: number): string {
  return `hnb_block_${ip}_${port}`;
}

export class HnbBlockService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly repo: SqliteHnbBlockRepository,
    private readonly logger: pino.Logger,
    // Read live rather than injected once — see module comment on why the
    // Iuh port can't be treated as a fixed constant like S1AP/NGAP.
    private readonly getIuhPort: () => number,
  ) {}

  start(intervalMs: number = 60_000): void {
    if (this.timer) return;
    this.reconcile().catch(err => this.logger.warn({ err: String(err) }, 'hnb-block: initial reconcile failed'));
    this.timer = setInterval(() => {
      this.reconcile().catch(err => this.logger.warn({ err: String(err) }, 'hnb-block: reconcile failed'));
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async ensureBaseline(): Promise<void> {
    await this.hostExecutor.executeCommand('nft', ['add', 'table', 'inet', TABLE]);
    await this.hostExecutor.executeCommand('nft', [
      'add', 'chain', 'inet', TABLE, CHAIN_IN,
      '{', 'type', 'filter', 'hook', 'input', 'priority', 'filter', ';', 'policy', 'accept', ';', '}',
    ]);
    await this.hostExecutor.executeCommand('nft', [
      'add', 'chain', 'inet', TABLE, CHAIN_OUT,
      '{', 'type', 'filter', 'hook', 'output', 'priority', 'filter', ';', 'policy', 'accept', ';', '}',
    ]);
  }

  /** Which IPs (and the port they were blocked on) currently have rules installed. */
  private async listInstalled(): Promise<{ chain: string; handle: number; ip: string; port: number }[]> {
    const result = await this.hostExecutor.executeCommand('nft', ['-j', 'list', 'table', 'inet', TABLE]);
    let parsed: any;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return [];
    }
    const rules: { chain: string; handle: number; ip: string; port: number }[] = [];
    for (const entry of parsed?.nftables ?? []) {
      const rule = entry?.rule;
      if (!rule?.comment || typeof rule.handle !== 'number') continue;
      const m = /^hnb_block_(.+)_(\d+)$/.exec(rule.comment);
      if (!m) continue;
      rules.push({ chain: rule.chain, handle: rule.handle, ip: m[1], port: Number(m[2]) });
    }
    return rules;
  }

  private async addRulesForIp(ip: string, port: number): Promise<void> {
    // Inbound: HNB -> this host, on HNBGW's Iuh listen port.
    await this.hostExecutor.executeCommand('nft', [
      'add', 'rule', 'inet', TABLE, CHAIN_IN,
      'ip', 'saddr', ip, 'sctp', 'dport', String(port), 'drop', 'comment', JSON.stringify(commentFor(ip, port)),
    ]);
    // Outbound: this host -> HNB, from HNBGW's Iuh port — severs an
    // already-established association instead of leaving it half-open.
    await this.hostExecutor.executeCommand('nft', [
      'add', 'rule', 'inet', TABLE, CHAIN_OUT,
      'ip', 'daddr', ip, 'sctp', 'sport', String(port), 'drop', 'comment', JSON.stringify(commentFor(ip, port)),
    ]);
  }

  private async removeRulesForIp(ip: string, port: number, installed: { chain: string; handle: number; ip: string; port: number }[]): Promise<void> {
    for (const r of installed.filter(r => r.ip === ip && r.port === port)) {
      await this.hostExecutor.executeCommand('nft', ['delete', 'rule', 'inet', TABLE, r.chain, 'handle', String(r.handle)])
        .catch(err => this.logger.warn({ err: String(err), ip, port, handle: r.handle }, 'hnb-block: failed to delete stale rule'));
    }
  }

  private async reconcile(): Promise<void> {
    await this.ensureBaseline();
    const installed = await this.listInstalled();
    const port = this.getIuhPort();
    const installedKeys = new Set(installed.map(r => `${r.ip}:${r.port}`));
    const desired = new Set(this.repo.getAll().map(b => `${b.ip}:${port}`));

    for (const r of installed) {
      if (!desired.has(`${r.ip}:${r.port}`)) await this.removeRulesForIp(r.ip, r.port, installed);
    }
    for (const key of desired) {
      if (!installedKeys.has(key)) {
        const ip = key.slice(0, key.lastIndexOf(':'));
        await this.addRulesForIp(ip, port).catch(err =>
          this.logger.warn({ err: String(err), ip, port }, 'hnb-block: failed to add block rules'));
      }
    }
  }

  async listBlocked(): Promise<{ ip: string; blockedBy: string; blockedAt: number }[]> {
    return this.repo.getAll();
  }

  async block(ip: string, blockedBy: string): Promise<void> {
    this.repo.add(ip, blockedBy);
    await this.reconcile();
  }

  async unblock(ip: string): Promise<void> {
    this.repo.remove(ip);
    await this.reconcile();
  }
}
