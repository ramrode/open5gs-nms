import axios from 'axios';

const api = axios.create({ baseURL: '/api/ocs', withCredentials: true });

export interface OcsConfig {
  bindIp: string;
  httpPort: number;
  originHost: string;
  originRealm: string;
  defaultOfferId?: string;
  lastSyncedAt?: string;
  lastSyncCounts?: { synced: number; failed: number; removed: number };
  installedWithVersion?: string;
  configuredWithVersion?: string;
}

export interface OcsStatus {
  success: boolean;
  installed: boolean;
  release: string | null;
  hasSavedConfig: boolean;
  serviceActive: boolean;
  mnesiaInitialized: boolean;
  httpHealthy: boolean;
  gyPeerWired: boolean;
  gyPeerOpen: boolean;
  currentConfig: OcsConfig;
}

export interface OcsConfigFile {
  path: string; label: string; group: string; language: string;
  restartServices: string[]; exists: boolean;
  shared?: boolean;
  sharedWith?: string;
}

export const ocsApi = {
  getStatus: async (): Promise<OcsStatus> => {
    const { data } = await api.get('/status');
    return data;
  },
  install: (): Promise<Response> =>
    fetch('/api/ocs/install', { method: 'POST', credentials: 'include' }),
  uninstall: (): Promise<Response> =>
    fetch('/api/ocs/uninstall', { method: 'POST', credentials: 'include' }),
  configure: async (input: { bindIp?: string; httpPort?: number; originHost?: string; originRealm?: string; defaultOfferId?: string }): Promise<{
    success: boolean; gyPeerOpen?: boolean;
    subscriberSync?: { synced: number; failed: number; removed: number };
    subscriberSyncWarning?: string;
  }> => {
    const { data } = await api.post('/configure', input);
    return data;
  },
  setUser: async (username: string, password: string): Promise<{ success: boolean; created?: boolean; error?: string }> => {
    const { data } = await api.post('/users', { username, password });
    return data;
  },
  syncSubscribers: async (): Promise<{ success: boolean; synced?: number; failed?: number; removed?: number; error?: string }> => {
    const { data } = await api.post('/sync-subscribers');
    return data;
  },
  start:   async () => { const { data } = await api.post('/start');   return data; },
  stop:    async () => { const { data } = await api.post('/stop');    return data; },
  restart: async () => { const { data } = await api.post('/restart'); return data; },
  getConfigs: async (): Promise<{ success: boolean; files: OcsConfigFile[] }> => {
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
