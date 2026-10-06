import { isAllowed, parseRobots, type RobotsRules } from './robots.js';

export interface PoliteFetchOptions {
  userAgent: string;
  /** Minimum delay between two requests to the same host. */
  delayMs?: number;
  retries?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class RobotsDisallowed extends Error {}

/**
 * The only way the collector touches the network: identified user-agent,
 * robots.txt honored, one request per second and per host, and a couple of
 * retries, because these websites alternate between 200s and failed TLS
 * handshakes from one minute to the next (see the 16/09 collection report).
 */
export class PoliteFetcher {
  private readonly robots = new Map<string, RobotsRules>();
  private readonly lastRequest = new Map<string, number>();
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: PoliteFetchOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async getJson(url: string): Promise<unknown> {
    const response = await this.get(url, 'application/json');
    return response.json();
  }

  private async get(url: string, accept: string): Promise<Response> {
    const target = new URL(url);
    const rules = await this.rulesFor(target);
    if (!isAllowed(rules, target.pathname + target.search)) {
      throw new RobotsDisallowed(`robots.txt disallows ${target.pathname} on ${target.host}`);
    }
    return this.request(target, accept);
  }

  private async rulesFor(target: URL): Promise<RobotsRules> {
    const cached = this.robots.get(target.host);
    if (cached) return cached;
    let rules: RobotsRules = { allow: [], disallow: [] };
    try {
      const response = await this.request(new URL('/robots.txt', target), 'text/plain');
      if (response.ok) rules = parseRobots(await response.text(), this.opts.userAgent);
    } catch {
      // No reachable robots.txt: nothing is disallowed (RFC 9309, 4xx/unreachable).
    }
    this.robots.set(target.host, rules);
    return rules;
  }

  private async request(target: URL, accept: string): Promise<Response> {
    const retries = this.opts.retries ?? 2;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      await this.waitTurn(target.host);
      try {
        const response = await this.fetchImpl(target, {
          headers: { 'user-agent': this.opts.userAgent, accept },
          redirect: 'follow',
        });
        if (response.status >= 500) {
          lastError = new Error(`HTTP ${response.status} on ${target.href}`);
          continue;
        }
        return response;
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async waitTurn(host: string): Promise<void> {
    const delay = this.opts.delayMs ?? 1000;
    const last = this.lastRequest.get(host);
    if (last !== undefined) {
      const wait = last + delay - Date.now();
      if (wait > 0) await this.sleep(wait);
    }
    this.lastRequest.set(host, Date.now());
  }
}
