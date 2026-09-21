import axios from 'axios';

const api = axios.create({ baseURL: '/api/ip-plan', withCredentials: true });

export type IpPlanCategory = 'core' | 'module';

export interface IpPlanEntry {
  service: string;
  label: string;
  category: IpPlanCategory;
  note?: string;
  liveApplyCapable: boolean;
  current: string | null;   // live reality, read fresh from that module's own state
  planned: string | null;   // the registry — only ever set by an Apply Plan run
}

export interface ProposedEntry extends IpPlanEntry {
  proposed: string;
  defaultChecked: boolean;
  warning?: string;
}

export interface MainInterface {
  name: string;
  ip: string;
  prefix: number;
  cidr: string;
}

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

export const ipPlanApi = {
  list: async (): Promise<{ entries: IpPlanEntry[] }> => { const { data } = await api.get('/'); return data; },
  suggest: async (): Promise<{ mainInterface: MainInterface | null }> => {
    const { data } = await api.get('/suggest'); return data;
  },
  propose: async (subnet: string): Promise<{ mainInterface: MainInterface | null; entries: ProposedEntry[] }> => {
    const { data } = await api.post('/propose', { subnet }); return data;
  },
  apply: async (entries: { service: string; ip: string }[]) => {
    const { data } = await api.post('/apply', { entries }); return data;
  },
  getApplyStatus: async (): Promise<{ run: IpPlanApplyRunState }> => {
    const { data } = await api.get('/apply/status'); return data;
  },
  // Convenience for a single consuming page's own blank-field pre-fill read
  // — pulls the full list and picks one entry's *planned* value, rather than
  // adding a second GET-by-key backend route for what's already a small,
  // cheap-to-fetch list. Never reads `current` — a page's own pre-fill
  // should only ever come from what an explicit Apply Plan run queued up
  // for it, never from live state belonging to a DIFFERENT module's own
  // Configure.
  get: async (service: string): Promise<string | null> => {
    const { data } = await api.get('/');
    const entries = data.entries as IpPlanEntry[];
    return entries.find(e => e.service === service)?.planned ?? null;
  },
};
