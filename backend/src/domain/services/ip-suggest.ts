// Suggests free-looking addresses within a detected subnet for the IP Plan
// feature. Deliberately narrow: "not already assigned to anything on THIS
// host" is all it checks — it does not (cannot, without an active network
// scan the user explicitly chose not to require) know about other real
// devices on the LAN using an address it hasn't seen. Every suggestion is
// meant to be reviewed/edited by the operator before saving, never applied
// silently.
//
// Bitwise IP math here follows CLAUDE.md's own documented gotcha (ip-utils.ts's
// real bug: an unmasked `&` on a first-octet->=128 address produces a
// corrupted signed Int32) — every intermediate value is normalized with
// `>>> 0`.

function ipToNum(ip: string): number {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function numToIp(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

// Picks `count` addresses from the top of the subnet's usable host range
// (skipping the network and broadcast addresses), working downward, that
// aren't in `occupied`. Starting from the top is a deliberate, simple
// convention — real deployments tend to hand out DHCP/static addresses
// from the bottom of a subnet, so the top is more likely to be free; it's
// still just a starting point the operator reviews, not a guarantee.
export function suggestFreeIps(cidr: string, occupied: Set<string>, count: number): string[] {
  const [network, prefixStr] = cidr.split('/');
  const prefix = Number(prefixStr);
  if (prefix < 1 || prefix > 30) return []; // /31,/32 have no usable host range; reject nonsense input rather than guess

  const networkNum = ipToNum(network);
  const hostBits = 32 - prefix;
  const broadcastNum = (networkNum | ((1 << hostBits) - 1) >>> 0) >>> 0;
  const firstHost = networkNum + 1;
  const lastHost = broadcastNum - 1;

  const suggestions: string[] = [];
  for (let n = lastHost; n >= firstHost && suggestions.length < count; n--) {
    const ip = numToIp(n);
    if (!occupied.has(ip)) suggestions.push(ip);
  }
  return suggestions;
}
