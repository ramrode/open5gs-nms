import { nsenter } from './dummy-interface';

// Extracted from frr-controller.ts's own GET /interfaces handler (the
// working "which interface owns the default route" trick already proven
// live there for the DNS/FQDN Migration Wizard's management-interface
// auto-select) — pulled out here so the new IP Plan feature can reuse it
// instead of reimplementing a 4th copy of "list real host interfaces."
// frr-controller.ts's own handler now calls this too.

export interface HostNetworkInterface {
  name: string;
  mac: string | null;
  state: string | null;
  addresses: string[]; // "ip/prefixlen" strings, IPv4 only
  isMgmt: boolean;
}

export async function listHostInterfaces(): Promise<{ interfaces: HostNetworkInterface[]; mgmtInterface: string | null }> {
  const { stdout } = await nsenter('ip', ['-j', 'addr', 'show']);
  const ifaces: any[] = JSON.parse(stdout);
  const { stdout: routeOut } = await nsenter('ip', ['-j', 'route', 'show', 'default']).catch(() => ({ stdout: '[]' }));
  const defaultRoutes: any[] = JSON.parse(routeOut);
  const mgmtIface = defaultRoutes[0]?.dev ?? null;
  const interfaces = ifaces
    .filter(i => !i.ifname?.startsWith('lo') && !i.ifname?.startsWith('docker') && !i.ifname?.startsWith('br-'))
    .map(i => ({
      name: i.ifname,
      mac: i.address ?? null,
      state: i.operstate ?? null,
      addresses: (i.addr_info ?? []).filter((a: any) => a.family === 'inet').map((a: any) => `${a.local}/${a.prefixlen}`),
      isMgmt: i.ifname === mgmtIface,
    }));
  return { interfaces, mgmtInterface: mgmtIface };
}

export interface MainInterface {
  name: string;
  ip: string;
  prefix: number;
  cidr: string; // network CIDR, e.g. "172.16.0.0/24"
}

// "The main interface" = whichever one owns the host's default IPv4 route
// (same definition frr-controller.ts already uses for its own mgmtInterface
// concept) — its first IPv4 address is what the IP Plan feature suggests
// addresses alongside.
export async function detectMainInterface(): Promise<MainInterface | null> {
  const { interfaces, mgmtInterface } = await listHostInterfaces();
  const main = interfaces.find(i => i.name === mgmtInterface) ?? interfaces.find(i => i.addresses.length > 0);
  if (!main || main.addresses.length === 0) return null;
  const [ip, prefixStr] = main.addresses[0].split('/');
  const prefix = Number(prefixStr);
  const cidr = networkCidr(ip, prefix);
  return { name: main.name, ip, prefix, cidr };
}

function networkCidr(ip: string, prefix: number): string {
  const parts = ip.split('.').map(Number);
  const ipNum = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const networkNum = (ipNum & mask) >>> 0;
  const octets = [(networkNum >>> 24) & 0xff, (networkNum >>> 16) & 0xff, (networkNum >>> 8) & 0xff, networkNum & 0xff];
  return `${octets.join('.')}/${prefix}`;
}
