import axios from 'axios';

const api = axios.create({ baseURL: '/api/pstn', withCredentials: true });

export interface PstnStatus {
  installed: boolean;
  services: { asterisk: boolean; 'kamailio-scscf': boolean };
  codecAmrLoaded: boolean;
  codecGsmLoaded: boolean;
  crossRanEnabled: boolean;
  externalTrunkEnabled: boolean;
  imsInstalled: boolean;
  imsConfigured: boolean;
  hasSavedConfig: boolean;
  dispatcherWired: boolean;
  pstnEnabled: boolean;
  currentConfig?: { asteriskIp: string; echoTestNumber?: string; externalTrunk?: PstnExternalTrunkConfig };
  extensionCount: number;
  gsmEnabledWithoutCrossRanCount: number;
  appVersion: string;
  configuredWithVersion?: string;
  configStale: boolean;
}

export interface PstnExtension {
  extension: string;
  subscriberImsi: string;
  subscriberNickname?: string;
  subscriberMsisdn?: string;
  label?: string;
  createdAt: string;
}

// Real external DID -> subscriber, inbound-only. See DidMapping's own
// comment in pstn-controller.ts for why this is separate from PstnExtension.
export interface DidMapping {
  did: string;
  subscriberImsi: string;
  subscriberNickname?: string;
  subscriberMsisdn?: string;
  subscriberGsmEnabled?: boolean;
  label?: string;
  createdAt: string;
}

// The caller ID a subscriber presents on OUTBOUND external-trunk calls —
// independent of their inbound DID(s) above. See OutboundCallerId's own
// comment in pstn-controller.ts for why this is a separate collection, not
// just "whichever DID this subscriber has mapped." One entry per
// subscriber (re-adding replaces the existing one, not a second entry).
export interface OutboundCallerId {
  subscriberImsi: string;
  callerId: string;
  subscriberNickname?: string;
  subscriberMsisdn?: string;
  label?: string;
  createdAt: string;
}

// A real external SIP trunk to a third-party Asterisk server with real
// PSTN/DID connectivity. See PstnExternalTrunkConfig's own comment in
// pstn-controller.ts for why bindIp is real (not loopback) and why this is
// plain UDP + an IP allowlist rather than SIP-TLS.
export interface PstnExternalTrunkConfig {
  enabled: boolean;
  bindIp: string;
  bindPort: number;
  interfaceMode: 'dummy' | 'existing';
  externalMediaAddress?: string;
  providerHost: string;
  providerPort: number;
  providerCidr: string;
}

export interface PstnConfigFile {
  path: string; label: string; group: string; language: string;
  restartServices: string[]; exists: boolean;
}

export const pstnApi = {
  getStatus:  async (): Promise<PstnStatus> => { const { data } = await api.get('/status'); return data; },
  configure:  async (asteriskIp?: string, echoTestNumber?: string) => { const { data } = await api.post('/configure', { asteriskIp, echoTestNumber }); return data; },
  enable:     async () => { const { data } = await api.post('/enable'); return data; },
  disable:    async () => { const { data } = await api.post('/disable'); return data; },
  // Same shape as enable/disable above — a 400 throws (caller catches
  // err.response.data.error/.collisions), matching every other mutating
  // call in this file rather than swallowing the error here.
  enableCrossRan:  async () => { const { data } = await api.post('/cross-ran/enable'); return data; },
  disableCrossRan: async () => { const { data } = await api.post('/cross-ran/disable'); return data; },
  start:      async () => { const { data } = await api.post('/start'); return data; },
  stop:       async () => { const { data } = await api.post('/stop'); return data; },
  restart:    async () => { const { data } = await api.post('/restart'); return data; },
  install:    () => fetch('/api/pstn/install', { method: 'POST', credentials: 'include' }),
  uninstall:  () => fetch('/api/pstn/uninstall', { method: 'POST', credentials: 'include' }),
  listExtensions: async (): Promise<{ extensions: PstnExtension[] }> => { const { data } = await api.get('/extensions'); return data; },
  addExtension:   async (extension: string, subscriberImsi: string, label?: string) => {
    const { data } = await api.post('/extensions', { extension, subscriberImsi, label }); return data;
  },
  removeExtension: async (extension: string) => {
    const { data } = await api.delete(`/extensions/${encodeURIComponent(extension)}`); return data;
  },
  listDidMappings: async (): Promise<{ didMappings: DidMapping[] }> => { const { data } = await api.get('/did-mappings'); return data; },
  addDidMapping:   async (did: string, subscriberImsi: string, label?: string) => {
    const { data } = await api.post('/did-mappings', { did, subscriberImsi, label }); return data;
  },
  removeDidMapping: async (did: string) => {
    const { data } = await api.delete(`/did-mappings/${encodeURIComponent(did)}`); return data;
  },
  // currentDid identifies the row being edited; newDid (if different) becomes
  // its new value — inline-edit alternative to remove+addDidMapping.
  updateDidMapping: async (currentDid: string, newDid: string, subscriberImsi: string, label?: string) => {
    const { data } = await api.put(`/did-mappings/${encodeURIComponent(currentDid)}`, { did: newDid, subscriberImsi, label }); return data;
  },
  listOutboundCallerIds: async (): Promise<{ outboundCallerIds: OutboundCallerId[] }> => { const { data } = await api.get('/outbound-caller-ids'); return data; },
  setOutboundCallerId:   async (subscriberImsi: string, callerId: string, label?: string) => {
    const { data } = await api.post('/outbound-caller-ids', { subscriberImsi, callerId, label }); return data;
  },
  // currentImsi identifies the row being edited; newSubscriberImsi (if
  // different) moves it to a new subscriber — inline-edit alternative to
  // removeOutboundCallerId+setOutboundCallerId.
  updateOutboundCallerId: async (currentImsi: string, newSubscriberImsi: string, callerId: string, label?: string) => {
    const { data } = await api.put(`/outbound-caller-ids/${encodeURIComponent(currentImsi)}`, { subscriberImsi: newSubscriberImsi, callerId, label }); return data;
  },
  removeOutboundCallerId: async (subscriberImsi: string) => {
    const { data } = await api.delete(`/outbound-caller-ids/${encodeURIComponent(subscriberImsi)}`); return data;
  },
  // providerCidr/externalMediaAddress omitted or blank -> the backend
  // derives/defaults them (providerCidr from providerHost, externalMediaAddress
  // from bindIp) — same "optional at the input boundary" shape as every
  // other optional field in this file, distinct from PstnExternalTrunkConfig
  // itself (which always reports the fully-resolved values back from /status).
  configureExternalTrunk: async (config: { bindIp: string; bindPort: number; interfaceMode: 'dummy' | 'existing'; externalMediaAddress?: string; providerHost: string; providerPort: number; providerCidr?: string }) => {
    const { data } = await api.post('/external-trunk/configure', config); return data;
  },
  enableExternalTrunk:  async () => { const { data } = await api.post('/external-trunk/enable'); return data; },
  disableExternalTrunk: async () => { const { data } = await api.post('/external-trunk/disable'); return data; },
  getConfigs: async (): Promise<{ success: boolean; files: PstnConfigFile[] }> => {
    const { data } = await api.get('/configs');
    return data;
  },
  getConfigContent: async (path: string): Promise<{ success: boolean; content: string }> => {
    const { data } = await api.get('/configs/content', { params: { path } });
    return data;
  },
  saveConfigContent: async (path: string, content: string) => {
    const { data } = await api.put('/configs/content', { path, content });
    return data;
  },
  restartServices: async (services: string[]) => {
    const { data } = await api.post('/configs/restart', { services });
    return data;
  },
};
