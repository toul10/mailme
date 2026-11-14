import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * Which mail hosts the API may connect to on a user's behalf (credentials probe) — SSRF guard.
 *
 * The API process sits on the internal network (compose: postgres, worker, Caddy; the cloud metadata service), so a
 * user-supplied IMAP/SMTP host must be a public DNS name that resolves only to public addresses:
 * - syntax: a dotted name whose last label is alphabetic (or an IDN `xn--` label); no IP literals, no single-label
 *   names, no local-only suffixes (localhost, .local, .internal, …);
 * - resolution: every address it resolves to must be public (no loopback, RFC 1918, CGNAT, link-local, ULA,
 *   multicast, documentation or reserved ranges; IPv4-mapped/NAT64 IPv6 are checked as IPv4).
 * The worker and CLI are operator tools and are not restricted here.
 */

const LOCAL_SUFFIXES = ["localhost", "local", "internal", "intranet", "lan", "home", "home.arpa", "corp", "localdomain", "invalid", "test", "onion"];

/** User-facing reason, or null when the name is acceptable. `host` is already lower-cased and trimmed. */
export function hostSyntaxProblem(host: string): string | null {
  const h = host.replace(/\.$/, "");
  if (!h) return "The server name is missing";
  if (isIP(h) !== 0 || h.startsWith("[") || h.includes(":")) return "Enter a server name (e.g. mail.example.com), not an IP address";
  const labels = h.split(".");
  if (labels.length < 2 || labels.some((l) => l.length === 0)) return "Enter the full server name (e.g. mail.example.com)";
  const tld = labels[labels.length - 1]!;
  // An all-numeric / hex last label ("10.0.0.010", "0x7f.1") would be parsed as an address by getaddrinfo.
  if (!/^[a-z]{2,63}$/.test(tld) && !/^xn--[a-z0-9-]{1,59}$/.test(tld)) return "Invalid server name";
  for (const suffix of LOCAL_SUFFIXES) {
    if (h === suffix || h.endsWith(`.${suffix}`)) return "The server must be public (not a local or internal name)";
  }
  return null;
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // includes the Docker bridge / compose networks
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64], // discard
  ["2001::", 23], // IETF protocol assignments (incl. Teredo)
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // ULA
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** IPv4 embedded in an IPv4-mapped (::ffff:a.b.c.d / ::ffff:7f00:1) or NAT64 (64:ff9b::/96) IPv6 address. */
function embeddedIpv4(addr: string): string | null {
  const m = /^(?:::ffff:|64:ff9b::)(?:(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(addr);
  if (!m) return null;
  if (m[1]) return m[1];
  const hi = parseInt(m[2]!, 16);
  const lo = parseInt(m[3]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** true if `addr` (an IP literal as returned by DNS) is not a public unicast address. */
export function isNonPublicAddress(addr: string): boolean {
  const bare = addr.replace(/%.*$/, "");
  const family = isIP(bare);
  if (family === 4) return blocked.check(bare, "ipv4");
  if (family === 6) {
    const v4 = embeddedIpv4(bare);
    if (v4) return isIP(v4) !== 4 || blocked.check(v4, "ipv4");
    return blocked.check(bare, "ipv6");
  }
  return true;
}

/** All addresses of a host name (A + AAAA). Injected in tests; the default uses the system resolver. */
export type HostResolver = (host: string) => Promise<string[]>;

export const systemResolver: HostResolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export type HostCheck = { ok: true; addresses: string[] } | { ok: false; kind: "policy" | "dns"; reason: string };

/** Syntax + resolution check before the API opens a connection to `host`. A lookup failure means "don't connect". */
export async function checkPublicHost(host: string, resolve: HostResolver): Promise<HostCheck> {
  const syntax = hostSyntaxProblem(host);
  if (syntax) return { ok: false, kind: "policy", reason: syntax };
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    return { ok: false, kind: "dns", reason: "Server not found (DNS)" };
  }
  if (addresses.length === 0) return { ok: false, kind: "dns", reason: "Server not found (DNS)" };
  if (addresses.some(isNonPublicAddress)) return { ok: false, kind: "policy", reason: "The server must be public (not an internal address)" };
  return { ok: true, addresses };
}
