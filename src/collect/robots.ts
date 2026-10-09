/**
 * Minimal robots.txt reader: the groups that apply to our user-agent (or to
 * `*` when none names it), Allow/Disallow by longest matching prefix, `*` and
 * `$` wildcards. Enough to honor what estates' websites actually publish.
 */
export interface RobotsRules {
  allow: string[];
  disallow: string[];
  /** `Sitemap:` lines, which apply to every user-agent. */
  sitemaps: string[];
}

export function parseRobots(text: string, userAgent: string): RobotsRules {
  const agent = userAgent.toLowerCase().split('/')[0]!;
  const groups: { agents: string[]; allow: string[]; disallow: string[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  const sitemaps: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' && value) current.allow.push(value);
    if (key === 'disallow' && value) current.disallow.push(value);
  }

  const named = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.includes(a)));
  const chosen = named.length > 0 ? named : groups.filter((g) => g.agents.includes('*'));
  return {
    allow: chosen.flatMap((g) => g.allow),
    disallow: chosen.flatMap((g) => g.disallow),
    sitemaps,
  };
}

function matchLength(pattern: string, path: string): number {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const regex = new RegExp(
    '^' + body.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : ''),
  );
  return regex.test(path) ? body.length : -1;
}

export function isAllowed(rules: RobotsRules, path: string): boolean {
  const best = (patterns: string[]) => Math.max(-1, ...patterns.map((p) => matchLength(p, path)));
  const allow = best(rules.allow);
  const disallow = best(rules.disallow);
  return disallow < 0 || allow >= disallow;
}
