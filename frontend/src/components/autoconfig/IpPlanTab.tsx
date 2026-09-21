import { useState, useEffect, useCallback, useRef } from 'react';
import { Wand2, PlayCircle, AlertCircle, RefreshCw, Check, X, Clock } from 'lucide-react';
import toast from 'react-hot-toast';
import { clsx } from 'clsx';
import {
  ipPlanApi, type IpPlanEntry, type ProposedEntry, type MainInterface,
  type IpPlanApplyRunState, type IpPlanApplyStatus,
} from '../../api/ip-plan';

const POLL_MS = 1500;

// Fixed facts about each live-capable module's own Configure cost — not
// worth a backend round-trip, these don't change host to host. Shown next
// to a checked row so "restart every 17 core NFs" and "restart one file
// that changed" don't look like the same size of action.
const RESTART_HINTS: Record<string, string> = {
  'mme-s1mme': 'restarts only the NF whose file actually changed',
  'sgwc': 'restarts only the NF whose file actually changed',
  'sgwu-s1u': 'restarts only the NF whose file actually changed',
  'amf-ngap': 'restarts only the NF whose file actually changed',
  'upf-n3': 'restarts only the NF whose file actually changed',
  'smf-pfcp': 'restarts only the NF whose file actually changed',
  'local-upf-pfcp': 'restarts only the NF whose file actually changed',
  'secgw-gateway': '~30s+ — regenerates certs, restarts strongSwan',
  'vowifi-epdg': '~1min+ — regenerates certs, restarts ePDG/AAA/SMF/HSS/BIND',
  'pstn-external-trunk': 'restarts Asterisk (drops any active PSTN call)',
  'gsm-bsc-mgw': 'restarts osmo-bsc/osmo-mgw (drops any active 2G call)',
  'gsm-sgsn-gb': 'restarts osmo-bsc/osmo-mgw (drops any active 2G call)',
  'ims-pcscf': 'heaviest — 14+ sequential service restarts, tens of seconds',
  'ims-rtpengine': 'heaviest — 14+ sequential service restarts, tens of seconds',
  'mms-mm1': '~15s+ — rebuilds the MM1 proxy binary, restarts VectorCore MMSC',
};

const STATUS_LABEL: Record<IpPlanApplyStatus, string> = {
  'applied-live': 'Applied live',
  'saved-for-later': 'Saved for later',
  'failed': 'Failed',
};
const STATUS_COLOR: Record<IpPlanApplyStatus, string> = {
  'applied-live': 'text-nms-green',
  'saved-for-later': 'text-nms-text-dim',
  'failed': 'text-nms-red',
};

// "Propose IP Plan" -> review a current-vs-proposed diff -> "Apply Plan".
// Deliberately two explicit steps, nothing automatic: this tool exists to
// mass-plan/mass-change IPs in one place instead of visiting every module's
// own page, but it must never silently write anything — a module's IP only
// ever changes here when the operator reviews a proposal and applies it.
export function IpPlanTab() {
  const [mode, setMode] = useState<'idle' | 'proposed'>('idle');
  const [entries, setEntries] = useState<IpPlanEntry[]>([]);
  const [proposed, setProposed] = useState<ProposedEntry[]>([]);
  const [proposedValues, setProposedValues] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [subnet, setSubnet] = useState('');
  const [mainInterface, setMainInterface] = useState<MainInterface | null>(null);
  const [loading, setLoading] = useState(true);
  const [proposing, setProposing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [run, setRun] = useState<IpPlanApplyRunState | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ entries: e }, { mainInterface: mi }] = await Promise.all([ipPlanApi.list(), ipPlanApi.suggest()]);
      setEntries(e);
      setMainInterface(mi);
      if (mi && !subnet) setSubnet(mi.cidr);
    } catch { /* ignore */ }
    finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const handlePropose = async () => {
    if (!subnet.trim()) { toast.error('Enter a subnet first, e.g. 10.0.1.0/24'); return; }
    setProposing(true);
    try {
      const { mainInterface: mi, entries: p } = await ipPlanApi.propose(subnet.trim());
      setMainInterface(mi);
      setProposed(p);
      setProposedValues(Object.fromEntries(p.map(e => [e.service, e.proposed])));
      setChecked(Object.fromEntries(p.map(e => [e.service, e.liveApplyCapable && e.defaultChecked])));
      setRun(null);
      setMode('proposed');
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? err.message);
    } finally {
      setProposing(false);
    }
  };

  const handleApply = async () => {
    const toApply = proposed
      .filter(e => checked[e.service] && e.liveApplyCapable)
      .map(e => ({ service: e.service, ip: (proposedValues[e.service] ?? e.proposed).trim() }))
      .filter(e => !!e.ip);
    if (toApply.length === 0) { toast.error('Nothing checked — pick at least one row to apply'); return; }
    setApplying(true);
    setRun(null);
    try {
      await ipPlanApi.apply(toApply);
    } catch (err: any) {
      setApplying(false);
      toast.error(err?.response?.data?.error ?? err.message);
      return;
    }
    pollRef.current = setInterval(async () => {
      try {
        const { run: state } = await ipPlanApi.getApplyStatus();
        setRun(state);
        if (state.status === 'complete' || state.status === 'failed') {
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          setApplying(false);
          await load();
          const failedCount = state.results.filter(r => r.status === 'failed').length;
          if (failedCount > 0) toast.error(`Apply Plan finished with ${failedCount} row(s) failed — see details below.`);
          else toast.success('Apply Plan completed.');
        }
      } catch { /* transient poll failure — keep trying */ }
    }, POLL_MS);
  };

  const resultFor = (service: string) => run?.results.find(r => r.service === service);

  const core = (mode === 'idle' ? entries : proposed).filter(e => e.category === 'core');
  const modules = (mode === 'idle' ? entries : proposed).filter(e => e.category === 'module');

  const renderIdleRow = (e: IpPlanEntry) => (
    <div key={e.service} className="grid grid-cols-1 md:grid-cols-3 gap-3 items-start py-2 border-b border-nms-border last:border-b-0">
      <div className="md:pt-1">
        <p className="text-sm text-nms-text font-medium">{e.label}</p>
        {e.note && <p className="text-xs text-nms-text-dim mt-0.5">{e.note}</p>}
      </div>
      <div className="md:col-span-2 font-mono text-xs pt-1">
        {e.current ? <span className="text-nms-text">{e.current}</span> : <span className="text-nms-text-dim">not configured</span>}
      </div>
    </div>
  );

  const renderProposedRow = (e: ProposedEntry) => {
    const result = resultFor(e.service);
    return (
      <div key={e.service} className="grid grid-cols-1 md:grid-cols-[auto_1fr_1fr_1fr] gap-3 items-start py-2 border-b border-nms-border last:border-b-0">
        <div className="pt-1">
          <input
            type="checkbox"
            disabled={!e.liveApplyCapable || applying}
            checked={!!checked[e.service]}
            onChange={ev => setChecked(c => ({ ...c, [e.service]: ev.target.checked }))}
            className="w-4 h-4 rounded border-nms-border accent-nms-accent cursor-pointer disabled:opacity-30"
          />
        </div>
        <div>
          <p className="text-sm text-nms-text font-medium">{e.label}</p>
          {e.note && <p className="text-xs text-nms-text-dim mt-0.5">{e.note}</p>}
          {!e.liveApplyCapable && (
            <p className="text-xs text-amber-400 mt-0.5">Plan only — apply from that module's own page</p>
          )}
          {e.warning && <p className="text-xs text-amber-400 mt-0.5">{e.warning}</p>}
          {e.liveApplyCapable && checked[e.service] && RESTART_HINTS[e.service] && (
            <p className="text-xs text-nms-text-dim mt-0.5 flex items-center gap-1"><Clock className="w-3 h-3" /> {RESTART_HINTS[e.service]}</p>
          )}
        </div>
        <div className="font-mono text-xs pt-1">
          {e.current ? <span className="text-nms-text">{e.current}</span> : <span className="text-nms-text-dim">not configured</span>}
        </div>
        <div>
          <input
            value={proposedValues[e.service] ?? ''}
            onChange={ev => setProposedValues(v => ({ ...v, [e.service]: ev.target.value }))}
            disabled={applying}
            placeholder="not set"
            className="nms-input font-mono text-xs w-full"
          />
          {result && (
            <p className={clsx('text-xs mt-1 flex items-center gap-1', STATUS_COLOR[result.status])}>
              {result.status === 'failed' ? <X className="w-3 h-3" /> : <Check className="w-3 h-3" />}
              {STATUS_LABEL[result.status]}{result.error ? ` — ${result.error}` : ''}
            </p>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="nms-card">
        <div className="flex items-start justify-between flex-wrap gap-3 mb-2">
          <div>
            <h2 className="text-sm font-semibold text-nms-text">Static IP Plan</h2>
            <p className="text-xs text-nms-text-dim mt-1 max-w-2xl">
              Mass-plan every static IP the system could need — including modules you haven't
              installed yet — instead of visiting each module's own page. Nothing here ever
              changes a module's real config except an explicit Apply Plan run.
            </p>
          </div>
          {mode === 'idle' ? (
            <div className="flex items-center gap-2 shrink-0">
              <input
                value={subnet}
                onChange={ev => setSubnet(ev.target.value)}
                placeholder="10.0.1.0/24"
                className="nms-input font-mono text-xs w-36"
                title="Subnet to suggest addresses from — pre-filled from the detected main interface, editable"
              />
              <button onClick={handlePropose} disabled={proposing || loading} className="nms-btn-primary flex items-center gap-2 text-sm">
                <Wand2 className={`w-4 h-4 ${proposing ? 'animate-pulse' : ''}`} /> {proposing ? 'Proposing…' : 'Propose IP Plan'}
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => setMode('idle')} disabled={applying} className="nms-btn-ghost text-xs px-2.5 py-1.5">
                Back
              </button>
              <button onClick={handleApply} disabled={applying} className="nms-btn-primary flex items-center gap-2 text-sm">
                <PlayCircle className={`w-4 h-4 ${applying ? 'animate-pulse' : ''}`} /> {applying ? 'Applying…' : 'Apply Plan'}
              </button>
            </div>
          )}
        </div>

        {mainInterface && (
          <p className="text-xs text-nms-text-dim mb-2">
            Detected main interface: <span className="font-mono text-nms-text">{mainInterface.name}</span> (
            <span className="font-mono text-nms-text">{mainInterface.ip}/{mainInterface.prefix}</span>).
          </p>
        )}
        {mode === 'idle' ? (
          <div className="flex items-start gap-2 rounded-lg border border-nms-border bg-nms-surface-2 px-3 py-2 mb-4">
            <AlertCircle className="w-3.5 h-3.5 text-nms-text-dim shrink-0 mt-0.5" />
            <p className="text-xs text-nms-text-dim leading-relaxed">
              Values below are read live from each module's own state — nothing is editable here.
              Click "Propose IP Plan" to get a reviewable, editable plan.
            </p>
          </div>
        ) : (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 mb-4">
            <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-200 leading-relaxed">
              Only checked rows are touched by Apply Plan. Suggestions are only checked against
              addresses already assigned on this host — not a live scan of every device on your
              LAN. A checked row for an already-live module restarts that service now — review the
              restart hint before applying.
            </p>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-8 text-nms-text-dim text-sm">
            <RefreshCw className="w-4 h-4 animate-spin mr-2" /> Loading…
          </div>
        ) : (
          <>
            {mode === 'proposed' && (
              <div className="hidden md:grid grid-cols-[auto_1fr_1fr_1fr] gap-3 text-xs font-semibold text-nms-text-dim uppercase tracking-wider pb-1 border-b border-nms-border">
                <span />
                <span>Service</span>
                <span>Current</span>
                <span>Proposed</span>
              </div>
            )}
            <h3 className="text-xs font-semibold text-nms-text uppercase tracking-wider mt-4 mb-1">Core Network</h3>
            <div>{mode === 'idle' ? core.map(e => renderIdleRow(e as IpPlanEntry)) : core.map(e => renderProposedRow(e as ProposedEntry))}</div>
            <h3 className="text-xs font-semibold text-nms-text uppercase tracking-wider mt-6 mb-1">Optional Modules</h3>
            <div>{mode === 'idle' ? modules.map(e => renderIdleRow(e as IpPlanEntry)) : modules.map(e => renderProposedRow(e as ProposedEntry))}</div>
          </>
        )}
      </div>
    </div>
  );
}
