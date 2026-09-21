import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';
import { IConfigRepository } from '../../domain/interfaces/config-repository';
import { AutoConfigUseCase, deriveCurrentAutoConfigInput, AutoConfigInput } from './auto-config';
import { configureSecgw, getSecgwStaleness } from '../../interfaces/rest/secgw-controller';
import { configureVowifi, VowifiConfigureError, getVowifiStaleness } from '../../interfaces/rest/vowifi-controller';
import {
  readPstnState, writePstnState, applyExternalTrunkChange, getPstnStaleness,
} from '../../interfaces/rest/pstn-controller';
import { configureGsm, getGsmStaleness } from '../../interfaces/rest/gsm-controller';
import { readCurrentImsConfig, configureIms, getImsStaleness } from '../../interfaces/rest/ims-controller';
import { readMmsState, configureMms, getMmsStaleness } from '../../interfaces/rest/mms-controller';
import { setPlannedIp } from '../../interfaces/rest/ip-plan-controller';

// ── IP Plan "Apply Plan" orchestrator ───────────────────────────────────────
//
// Modeled directly on module-fixall-usecase.ts: same constructor-DI shape,
// same runState/startApply/getRunState async-job pattern (POST /apply
// returns immediately, the frontend polls GET /apply/status), for the same
// reason that file chose it — this batch can realistically run minutes long
// (IMS alone is 14+ sequential service restarts).
//
// Per the 3 decisions confirmed with the user during design: live-apply is
// strictly per-row opt-in (the caller only ever passes rows the operator
// actually checked); SEPP and bind-dns NEVER live-apply (registry-only,
// always — SEPP's only live path is the generic core-config apply, which
// restarts all 17 NFs for 3 fields that only matter for N32 roaming); core-17
// DOES live-apply via the existing AutoConfigUseCase, batched into one call
// since its apply* toggles need whole field-groups together, not one at a
// time.

export type IpPlanApplyStatus = 'applied-live' | 'saved-for-later' | 'failed';

export interface IpPlanApplyEntryResult {
  service: string;
  status: IpPlanApplyStatus;
  error?: string;
}

export interface IpPlanApplyRunState {
  status: 'idle' | 'running' | 'complete' | 'failed';
  startedAt?: string;
  completedAt?: string;
  results: IpPlanApplyEntryResult[];
}

const REGISTRY_ONLY_SERVICES = ['sepp-sbi', 'sepp-n32c', 'sepp-n32f', 'bind-dns'];
const CORE17_INTERFACE_GROUP = ['mme-s1mme', 'sgwu-s1u', 'amf-ngap', 'upf-n3'];
const CORE17_PFCP_GROUP = ['sgwc', 'smf-pfcp', 'local-upf-pfcp'];
const CORE17_SERVICES = [...CORE17_INTERFACE_GROUP, ...CORE17_PFCP_GROUP];

export class IpPlanApplyUseCase {
  private runState: IpPlanApplyRunState = { status: 'idle', results: [] };

  constructor(
    private readonly configRepo: IConfigRepository,
    private readonly autoConfigUseCase: AutoConfigUseCase,
    private readonly subscriberRepo: ISubscriberRepository,
    private readonly hostExecutor: IHostExecutor,
    private readonly mongoUri: string,
    private readonly logger: pino.Logger,
    private readonly auditLogger: IAuditLogger,
  ) {}

  startApply(entries: { service: string; ip: string }[], user: string): { started: true } | { started: false; error: string } {
    if (this.runState.status === 'running') {
      return { started: false, error: 'An IP plan apply is already in progress.' };
    }
    this.runState = { status: 'running', startedAt: new Date().toISOString(), results: [] };
    this.runApply(entries, user).catch(err => {
      this.logger.error({ err: String(err) }, 'ip-plan-apply: unexpected top-level failure');
      this.runState.status = 'failed';
      this.runState.completedAt = new Date().toISOString();
    });
    return { started: true };
  }

  getRunState(): IpPlanApplyRunState {
    return this.runState;
  }

  private async runApply(entries: { service: string; ip: string }[], user: string): Promise<void> {
    const byService = new Map(entries.map(e => [e.service, e.ip]));
    const results: IpPlanApplyEntryResult[] = [];

    // Registry-only (SEPP x3, bind-dns) — always just saved, never live.
    for (const service of REGISTRY_ONLY_SERVICES) {
      const ip = byService.get(service);
      if (ip === undefined) continue;
      setPlannedIp(service, ip);
      results.push({ service, status: 'saved-for-later' });
      this.runState.results = results;
    }

    const core17Requested = CORE17_SERVICES.filter(s => byService.has(s));
    if (core17Requested.length > 0) {
      results.push(...await this.applyCore17(core17Requested, byService));
      this.runState.results = results;
    }

    if (byService.has('secgw-gateway')) {
      results.push(await this.applySecgw(byService.get('secgw-gateway')!));
      this.runState.results = results;
    }

    if (byService.has('vowifi-epdg')) {
      results.push(await this.applyVowifi(byService.get('vowifi-epdg')!));
      this.runState.results = results;
    }

    const gsmRequested = ['gsm-bsc-mgw', 'gsm-sgsn-gb'].filter(s => byService.has(s));
    if (gsmRequested.length > 0) {
      results.push(...await this.applyGsm(gsmRequested, byService));
      this.runState.results = results;
    }

    // IMS runs before PSTN external trunk / MMS deliberately — both
    // applyExternalTrunkChange() and configureMms() internally require IMS
    // already configured and fail otherwise. Sequential + this ordering
    // resolves that dependency for free when all are in the same batch.
    let imsFailed = false;
    const imsRequested = ['ims-pcscf', 'ims-rtpengine'].filter(s => byService.has(s));
    if (imsRequested.length > 0) {
      const imsResults = await this.applyIms(imsRequested, byService);
      results.push(...imsResults);
      this.runState.results = results;
      imsFailed = imsResults.some(r => r.status === 'failed');
    }

    if (byService.has('pstn-external-trunk')) {
      results.push(
        imsFailed
          ? { service: 'pstn-external-trunk', status: 'failed', error: 'IMS apply failed earlier in this batch' }
          : await this.applyPstnExternalTrunk(byService.get('pstn-external-trunk')!),
      );
      this.runState.results = results;
    }

    if (byService.has('mms-mm1')) {
      results.push(
        imsFailed
          ? { service: 'mms-mm1', status: 'failed', error: 'IMS apply failed earlier in this batch' }
          : await this.applyMms(byService.get('mms-mm1')!),
      );
      this.runState.results = results;
    }

    this.runState.status = 'complete';
    this.runState.completedAt = new Date().toISOString();

    const allOk = results.every(r => r.status !== 'failed');
    await this.auditLogger.log({
      action: 'ip_plan_apply',
      user,
      details: results.map(r => `${r.service}:${r.status}`).join(' '),
      success: allOk,
    });
  }

  // ── per-service/per-group appliers ────────────────────────────────────────

  private async applySecgw(ip: string): Promise<IpPlanApplyEntryResult> {
    const service = 'secgw-gateway';
    const staleness = getSecgwStaleness();
    if (!(staleness.installedOnDisk && staleness.hasSavedConfig)) {
      setPlannedIp(service, ip);
      return { service, status: 'saved-for-later' };
    }
    try {
      const r = await configureSecgw({
        gatewayIp: ip,
        interfaceMode: staleness.savedInterfaceMode ?? 'dummy',
        poolCidr: staleness.savedPoolCidr ?? '',
      });
      if (!r.success) return { service, status: 'failed', error: r.error };
      return { service, status: 'applied-live' };
    } catch (err) {
      return { service, status: 'failed', error: String(err) };
    }
  }

  private async applyVowifi(ip: string): Promise<IpPlanApplyEntryResult> {
    const service = 'vowifi-epdg';
    const staleness = getVowifiStaleness();
    if (!(staleness.installedOnDisk && staleness.hasSavedConfig)) {
      setPlannedIp(service, ip);
      return { service, status: 'saved-for-later' };
    }
    try {
      await configureVowifi({
        epdgIp: ip,
        aaaListenIp: staleness.savedAaaListenIp || ip,
        interfaceMode: staleness.savedInterfaceMode ?? 'dummy',
      });
      return { service, status: 'applied-live' };
    } catch (err) {
      const message = err instanceof VowifiConfigureError ? err.message : String(err);
      return { service, status: 'failed', error: message };
    }
  }

  private async applyGsm(requested: string[], byService: Map<string, string>): Promise<IpPlanApplyEntryResult[]> {
    const staleness = await getGsmStaleness();
    if (!(staleness.installedOnDisk && staleness.configured)) {
      return requested.map(service => {
        setPlannedIp(service, byService.get(service)!);
        return { service, status: 'saved-for-later' as const };
      });
    }
    try {
      const input: { bscMgwBindIp?: string; sgsnGbRemoteIp?: string } = {};
      if (byService.has('gsm-bsc-mgw')) input.bscMgwBindIp = byService.get('gsm-bsc-mgw');
      if (byService.has('gsm-sgsn-gb')) input.sgsnGbRemoteIp = byService.get('gsm-sgsn-gb');
      await configureGsm(input);
      return requested.map(service => ({ service, status: 'applied-live' as const }));
    } catch (err) {
      const error = String(err);
      return requested.map(service => ({ service, status: 'failed' as const, error }));
    }
  }

  private async applyIms(requested: string[], byService: Map<string, string>): Promise<IpPlanApplyEntryResult[]> {
    const staleness = await getImsStaleness();
    if (!(staleness.installed && staleness.hasSavedConfig)) {
      return requested.map(service => {
        setPlannedIp(service, byService.get(service)!);
        return { service, status: 'saved-for-later' as const };
      });
    }
    const current = readCurrentImsConfig();
    if (!current) {
      return requested.map(service => ({ service, status: 'failed' as const, error: 'No saved IMS config on record' }));
    }
    try {
      const merged = { ...current };
      if (byService.has('ims-pcscf')) merged.pcscfIp = byService.get('ims-pcscf')!;
      if (byService.has('ims-rtpengine')) merged.rtpEngineIp = byService.get('ims-rtpengine')!;
      await configureIms(merged);
      return requested.map(service => ({ service, status: 'applied-live' as const }));
    } catch (err) {
      const error = String(err);
      return requested.map(service => ({ service, status: 'failed' as const, error }));
    }
  }

  private async applyPstnExternalTrunk(ip: string): Promise<IpPlanApplyEntryResult> {
    const service = 'pstn-external-trunk';
    const staleness = await getPstnStaleness();
    const state = readPstnState();
    if (!(staleness.installed && state?.externalTrunk != null)) {
      setPlannedIp(service, ip);
      return { service, status: 'saved-for-later' };
    }
    try {
      writePstnState({ ...state, externalTrunk: { ...state.externalTrunk, bindIp: ip } });
      await applyExternalTrunkChange(this.mongoUri, this.subscriberRepo, this.hostExecutor);
      return { service, status: 'applied-live' };
    } catch (err) {
      return { service, status: 'failed', error: String(err) };
    }
  }

  private async applyMms(ip: string): Promise<IpPlanApplyEntryResult> {
    const service = 'mms-mm1';
    const staleness = await getMmsStaleness();
    if (!(staleness.installed && staleness.hasSavedConfig)) {
      setPlannedIp(service, ip);
      return { service, status: 'saved-for-later' };
    }
    try {
      const r = await configureMms({ mm1PublicIp: ip }, this.subscriberRepo);
      if (!r.success) return { service, status: 'failed', error: r.error };
      return { service, status: 'applied-live' };
    } catch (err) {
      return { service, status: 'failed', error: String(err) };
    }
  }

  // Batched — AutoConfigUseCase's apply* toggles need whole field-groups
  // together (applyInterfaces needs all 4 interface IPs; applyPfcp needs all
  // 3 PFCP fields and must not silently trip over localUpfOnly/
  // localSgwuOnly), so every checked core-17 entry in this apply request
  // becomes exactly one execute() call, not one per entry.
  private async applyCore17(requested: string[], byService: Map<string, string>): Promise<IpPlanApplyEntryResult[]> {
    try {
      const configs = await this.configRepo.loadAll();
      const input: AutoConfigInput = { ...deriveCurrentAutoConfigInput(configs) };

      input.applyInterfaces = requested.some(s => CORE17_INTERFACE_GROUP.includes(s));
      input.applyPfcp = requested.some(s => CORE17_PFCP_GROUP.includes(s));
      input.applyPlmn = false;
      input.applySessionPools = false;

      if (byService.has('mme-s1mme')) { input.s1mmeIP = byService.get('mme-s1mme'); input.s1mmeDev = undefined; }
      if (byService.has('amf-ngap')) { input.amfNgapIP = byService.get('amf-ngap'); input.amfNgapDev = undefined; }
      if (byService.has('sgwu-s1u')) input.sgwuGtpIP = byService.get('sgwu-s1u')!;
      if (byService.has('upf-n3')) input.upfGtpIP = byService.get('upf-n3')!;
      // Explicitly checking one of these 3 means the operator wants a real
      // IP actually used — force the corresponding "*Only" loopback override
      // off, or AutoConfigUseCase silently discards the new address back to
      // its hardcoded loopback and this would report success for nothing.
      if (byService.has('sgwc'))            { input.sgwcPfcpIP = byService.get('sgwc'); input.localSgwuOnly = false; }
      if (byService.has('smf-pfcp'))        { input.smfPfcpIP = byService.get('smf-pfcp'); input.localUpfOnly = false; }
      if (byService.has('local-upf-pfcp'))  { input.localUpfPfcpIP = byService.get('local-upf-pfcp'); input.localUpfOnly = false; }

      const result = await this.autoConfigUseCase.execute(input, 'ip-plan-apply');
      if (!result.success) {
        const error = result.message;
        return requested.map(service => ({ service, status: 'failed' as const, error }));
      }
      return requested.map(service => ({ service, status: 'applied-live' as const }));
    } catch (err) {
      const error = String(err);
      return requested.map(service => ({ service, status: 'failed' as const, error }));
    }
  }
}
