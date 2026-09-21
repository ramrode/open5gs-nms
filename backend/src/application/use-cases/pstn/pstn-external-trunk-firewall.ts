/**
 * nftables allowlist for the real external SIP trunk — restricts PSTN
 * Gateway's new `transport-external` SIP signaling port to the configured
 * provider CIDR. Own dedicated table (CLAUDE.md pattern #11's convention:
 * any new nftables feature gets its own table, never shared with an
 * existing one), hooked on `input` — deliberately NOT `forward` like this
 * project's other two nftables examples (subscriber-ip-accounting.ts,
 * ue-block-service.ts): those protect UE traffic passing THROUGH this host
 * to the internet, while SIP/RTP to Asterisk TERMINATES on this host
 * (Asterisk is a local process) — `forward` would silently protect nothing
 * here.
 *
 * Real, deliberate, accepted trade-off — read before touching this file:
 * only SIP signaling (bindPort) is allowlisted, never the RTP port range.
 * The RTP range (rtp.conf's rtpstart/rtpend) is confirmed INSTANCE-WIDE —
 * shared by scscf_trunk, asterisk2g_trunk, and this new external_trunk
 * alike (see pstn-controller.ts's own ensureStrictRtpDisabled() comment) —
 * so allowlisting it to the provider CIDR would also drop real UE-side RTP
 * for the existing internal PSTN Gateway/Cross-RAN calls, which never
 * originates from that CIDR either. There is no per-trunk RTP port
 * carve-out in real Asterisk to fall back on. This is narrower than it
 * sounds: an attacker outside providerCidr can never get the dialplan to
 * even allocate an RTP port toward them in the first place, since SIP
 * signaling — the only path into the dialplan — is the thing actually
 * allowlisted here. The residual exposure (unsolicited RTP injection into
 * an already-negotiated port, which strictrtp would normally mitigate) is
 * a pre-existing trade-off this deployment already made instance-wide
 * (ensureStrictRtpDisabled(), for an unrelated reason, before this feature
 * existed) — this module doesn't make it worse, and can't structurally
 * close it for the new trunk without deeper Asterisk internals work that's
 * out of scope here.
 *
 * Called synchronously from the external-trunk configure flow (same
 * "idempotent, reapplied on every Configure" shape as pstn-controller.ts's
 * own ensureStrictRtpDisabled()) — not a poll loop like the two existing
 * nftables examples above, since nothing here drifts independently between
 * Configure calls (the provider CIDR only ever changes when an operator
 * explicitly edits it).
 */

import { IHostExecutor } from '../../../domain/interfaces/host-executor';

const TABLE = 'open5gs_nms_pstn_ext';
const CHAIN = 'pstn_ext_in';

// Idempotent: flushes any previously-applied rules (from an earlier
// Configure with a different bindIp/bindPort/providerCidr) before adding
// the current pair fresh, rather than trying to diff old vs. new — matches
// this project's established "full rewrite on every Configure" convention.
//
// Real bug found live (2026-09-19): the original version of this function
// matched only on `udp dport <bindPort>`, with no destination-address
// qualifier at all — since bindPort defaults to the same 5060 every other
// trunk on this host uses (transport-trunk's scscf_trunk/asterisk2g_trunk,
// bound to a completely different loopback address), the "drop everything
// else" rule silently ate ALL port-5060 UDP traffic hitting this host,
// including Kamailio's own loopback OPTIONS pings to the INTERNAL trunk at
// 127.0.1.4:5060. That desynced S-CSCF's dispatcher (marked the internal
// PSTN Gateway destination down) and broke every short-code/echo-test/
// Cross-RAN call through it — a much bigger blast radius than the intended
// "restrict the new external-facing port" scope. Fixed by adding `ip daddr
// <bindIp>` to both rules, so this table only ever touches traffic destined
// for the external trunk's own dedicated address, never the unrelated
// internal loopback trunks that happen to share the same port number.
export async function applyExternalTrunkFirewall(
  hostExecutor: IHostExecutor,
  config: { bindIp: string; bindPort: number; providerCidr: string },
): Promise<void> {
  await hostExecutor.executeCommand('nft', ['add', 'table', 'inet', TABLE]);
  await hostExecutor.executeCommand('nft', [
    'add', 'chain', 'inet', TABLE, CHAIN,
    '{', 'type', 'filter', 'hook', 'input', 'priority', 'filter', ';', 'policy', 'accept', ';', '}',
  ]);
  await hostExecutor.executeCommand('nft', ['flush', 'chain', 'inet', TABLE, CHAIN]);
  await hostExecutor.executeCommand('nft', [
    'add', 'rule', 'inet', TABLE, CHAIN,
    'ip', 'daddr', config.bindIp, 'ip', 'saddr', config.providerCidr, 'udp', 'dport', String(config.bindPort), 'accept', 'comment', 'pstn_ext_sip',
  ]);
  await hostExecutor.executeCommand('nft', [
    'add', 'rule', 'inet', TABLE, CHAIN,
    'ip', 'daddr', config.bindIp, 'udp', 'dport', String(config.bindPort), 'drop', 'comment', 'pstn_ext_sip_deny',
  ]);
}

// Called when the external trunk is disabled — removes the whole table
// (both rules belong exclusively to this feature, nothing else shares it).
export async function removeExternalTrunkFirewall(hostExecutor: IHostExecutor): Promise<void> {
  await hostExecutor.executeCommand('nft', ['delete', 'table', 'inet', TABLE], undefined, { expectedFailure: true }).catch(() => {});
}
