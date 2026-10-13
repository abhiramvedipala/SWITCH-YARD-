import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import type { FastifyRequest } from 'fastify';
import { getSetting, setSetting, type Db } from '../db/index.js';

/**
 * Resolves the tailnet login that owns `ip` (null when the node has no user, e.g. a tagged node).
 * Throws when whois itself cannot run; the verifier logs that and fails closed.
 */
export type WhoisRunner = (ip: string) => Promise<string | null>;

export const WHOIS_TTL_MS = 60_000;

// PATH first (Homebrew), then the App Store bundle's CLI.
const TAILSCALE_BINS = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
const execFileAsync = promisify(execFile);

export const tailscaleWhois: WhoisRunner = async (ip) => {
  for (const bin of TAILSCALE_BINS) {
    try {
      const { stdout } = await execFileAsync(bin, ['whois', '--json', ip], { timeout: 5000 });
      const login = (JSON.parse(stdout) as { UserProfile?: { LoginName?: unknown } }).UserProfile
        ?.LoginName;
      return typeof login === 'string' && login !== '' ? login : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // not installed there; try the next
      throw err;
    }
  }
  throw new Error(`tailscale binary not found (looked for ${TAILSCALE_BINS.join(', ')})`);
};

export type RemoteVerdict = { ok: true; login: string } | { ok: false; reason: string };

/**
 * Checks a forwarded (Tailscale Serve) request: the `tailscale-user-login` header must match what
 * `tailscale whois` says about the forwarded IP, and must be the login pinned at first contact.
 * Whois results are cached per IP for 60 s; failures are cached too so a missing binary never
 * spawns a process per asset request. Fails closed on anything unexpected.
 */
export function createRemoteVerifier(
  db: Db,
  whois: WhoisRunner = tailscaleWhois,
  log: (line: string) => void = (l) => console.error(l),
) {
  const cache = new Map<string, { login: Promise<string | null>; expires: number }>();
  let lastLogAt = 0;
  const lookup = (ip: string) => {
    const hit = cache.get(ip);
    if (hit && hit.expires > Date.now()) return hit.login;
    if (cache.size > 1000) cache.clear(); // ponytail: tailnets are small; LRU if this ever matters
    const login = whois(ip).catch((err: unknown) => {
      const now = Date.now();
      if (now - lastLogAt > WHOIS_TTL_MS) {
        lastLogAt = now;
        log(`[remote] tailscale whois ${ip} failed, refusing remote requests: ${String(err)}`);
      }
      return null;
    });
    cache.set(ip, { login, expires: Date.now() + WHOIS_TTL_MS });
    return login;
  };

  return async (req: FastifyRequest): Promise<RemoteVerdict> => {
    const claimed = req.headers['tailscale-user-login'];
    // Serve appends the client IP as the LAST entry (Go's SetXForwarded); earlier ones are client-supplied.
    const ip = String(req.headers['x-forwarded-for'] ?? '')
      .split(',')
      .pop()!
      .trim();
    if (typeof claimed !== 'string' || claimed === '' || !isIP(ip))
      return { ok: false, reason: 'remote_identity_required' };
    if ((await lookup(ip)) !== claimed) return { ok: false, reason: 'remote_identity_unverified' };
    const owner = getSetting(db, 'remoteOwnerLogin', '');
    if (!owner) setSetting(db, 'remoteOwnerLogin', claimed);
    else if (owner !== claimed) return { ok: false, reason: 'remote_not_owner' };
    return { ok: true, login: claimed };
  };
}
