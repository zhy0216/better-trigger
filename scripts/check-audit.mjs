/* =============================================================================
   check-audit — deterministic dependency audit gate (plans/.../F3, todos/02).

   Two failure modes this guards against:

   1. The advisory endpoint follows the local registry. With ~/.npmrc pointing
      at npmmirror, a bare `bun audit` 404s (mirror has no advisory route), so
      CI on such a machine "passes" forever. This script always asks
      `https://registry.npmjs.org` explicitly.

   2. Bun's text audit lists every resolved version of a package next to one
      advisory, so a vulnerable esbuild 0.18.x transitively pulled by a tool
      visually indicts the safe 0.25.x the same tool also uses. Instead this
      script cross-references each advisory's `vulnerable_versions` range
      against the exact resolved version *and* lockfile resolution path
      recorded in bun.lock, and only reports real (advisory, version, chain)
      triples.

   Any unresolved finding fails. A finding may only be deferred by a narrow
   exception in scripts/audit-exceptions.json matched field-for-field on
   advisory URL + resolved version + chain — never by package name or
   severity alone. Exceptions need reason, exposure, owner and a future
   expiry; expired or now-matching-nothing exceptions fail the check.
   High/critical findings can never be excepted: upgrade or remove the chain.

   Usage: node scripts/check-audit.mjs            (or `bun run check:audit`)
          node scripts/check-audit.mjs --self-test  (offline logic check)
   ============================================================================= */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REGISTRY = 'https://registry.npmjs.org';
const root = fileURLToPath(new URL('..', import.meta.url));
const lockfile = `${root}bun.lock`;
const exceptionsFile = `${root}scripts/audit-exceptions.json`;

/** Numeric [major, minor, patch]; prerelease suffixes are ignored for
 *  ordering (ponytail: enough for advisory ranges, which pin releases). */
function parseVersion(v) {
  return v
    .replace(/^[~^>=<\s]+/, '')
    .split(/[-+]/)[0]
    .split('.')
    .map((n) => Number(n) || 0);
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** npm-style comparator subset used by GitHub advisories: "*" wildcard,
 *  "1.x", ">=a <b" AND groups and "||" OR groups.
 *  Unparseable ranges fail closed (treated as matching everything). */
function satisfies(version, range) {
  let parsed = true;
  const matched = String(range)
    .split('||')
    .some((group) => {
      const terms = group.trim().split(/\s+/).filter(Boolean);
      return terms.every((term) => {
        if (term === '*') return true;
        const wildcard = /^(\d+)\.x(?:\.x)?$/.exec(term);
        if (wildcard) return parseVersion(version)[0] === Number(wildcard[1]);
        const m = /^([<>]=?|=)?\s*(\d+\.\d+\.\d+(?:[-+][\w.]+)?)$/.exec(term);
        if (!m) {
          parsed = false;
          return false;
        }
        const c = compareVersions(version, m[2]);
        switch (m[1]) {
          case '<':
            return c < 0;
          case '<=':
            return c <= 0;
          case '>':
            return c > 0;
          case '>=':
            return c >= 0;
          default:
            return c === 0;
        }
      });
    });
  return parsed ? matched : true;
}

/** bun.lock is JSON with trailing commas; the only non-JSON bit to strip. */
function parseLock(text) {
  return JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
}

/** "@scope/pkg" segments contain '/', so rejoin them when walking a lock key. */
function keyToChain(key) {
  const segments = key.split('/');
  const names = [];
  for (let i = 0; i < segments.length; i += 1) {
    if (segments[i].startsWith('@') && i + 1 < segments.length) {
      names.push(`${segments[i]}/${segments[i + 1]}`);
      i += 1;
    } else {
      names.push(segments[i]);
    }
  }
  return names.join(' > ');
}

/** Every resolved package instance in the lock: name, version, chain. */
function lockEntries(lock) {
  const entries = [];
  for (const [key, value] of Object.entries(lock.packages ?? {})) {
    const [nameAtVersion] = value;
    const at = nameAtVersion.lastIndexOf('@');
    entries.push({
      name: nameAtVersion.slice(0, at),
      version: nameAtVersion.slice(at + 1),
      chain: keyToChain(key),
    });
  }
  return entries;
}

/** Real (advisory, resolved version, chain) triples from this lockfile. */
function findFindings(advisoriesByPackage, entries) {
  const findings = [];
  for (const [advisoryPackage, advisories] of Object.entries(advisoriesByPackage)) {
    for (const entry of entries.filter((e) => e.name === advisoryPackage)) {
      for (const advisory of advisories) {
        if (satisfies(entry.version, advisory.vulnerable_versions)) {
          findings.push({
            url: advisory.url,
            severity: advisory.severity,
            package: advisoryPackage,
            version: entry.version,
            chain: entry.chain,
          });
        }
      }
    }
  }
  return findings;
}

const EXEMPTIBLE = new Set(['low', 'moderate']);
const REQUIRED_EXCEPTION_FIELDS = ['url', 'version', 'chain', 'reason', 'exposure', 'owner', 'expires'];

/** Rules: exact advisory+version+chain match; metadata complete; unexpired;
 *  only low/moderate may be exempted; stale exceptions fail. */
function checkExceptions(findings, exceptions, now = new Date()) {
  const errors = [];
  const findingKey = (f) => `${f.url}@${f.version}@${f.chain}`;
  const used = new Set();
  for (const [i, exception] of exceptions.entries()) {
    const label = `exception #${i + 1} (${exception.url ?? '?'})`;
    const missing = REQUIRED_EXCEPTION_FIELDS.filter((f) => typeof exception[f] !== 'string' || !exception[f].trim());
    if (missing.length > 0) {
      errors.push(`${label}: missing ${missing.join(', ')} — every exception needs advisory url, resolved version, chain, reason, exposure, owner and expires`);
      continue;
    }
    const expiry = new Date(`${exception.expires}T23:59:59Z`);
    if (Number.isNaN(expiry.getTime())) {
      errors.push(`${label}: expires "${exception.expires}" is not an ISO date`);
      continue;
    }
    if (expiry < now) {
      errors.push(`${label}: expired on ${exception.expires} — re-upgrade the chain or renew with justification`);
      continue;
    }
    const matches = findings.filter((f) => findingKey(f) === findingKey(exception));
    if (matches.length === 0) {
      errors.push(`${label}: matches no current finding — the advisory, resolved version or chain has moved; delete or fix this exception`);
      continue;
    }
    for (const match of matches) {
      if (!EXEMPTIBLE.has(match.severity)) {
        errors.push(`${label}: ${match.severity} findings cannot be excepted — upgrade or remove ${match.package}@${match.version} (${match.chain})`);
      }
      used.add(findingKey(match));
    }
  }
  for (const finding of findings) {
    if (!used.has(findingKey(finding))) {
      errors.push(`${finding.severity}: ${finding.package}@${finding.version} (${finding.chain}) — ${finding.url}`);
    }
  }
  return errors;
}

function loadExceptions(path) {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf8'));
}

/* --------------------------------------------------------------------------
   Self-test: offline checks of the matcher and the exception rules, using a
   synthetic tree shaped like the pre-fix one (vulnerable 0.18/0.21 esbuild
   alongside safe 0.25/0.28 copies, vulnerable vite 5 beside safe vite 8).
   -------------------------------------------------------------------------- */
function selfTest() {
  const assert = (cond, msg) => {
    if (!cond) {
      console.error(`✗ self-test: ${msg}`);
      process.exit(1);
    }
  };
  assert(satisfies('0.18.20', '<=0.24.2'), '0.18.20 must be vulnerable to <=0.24.2');
  assert(!satisfies('0.25.12', '<=0.24.2'), '0.25.12 must NOT be flagged by <=0.24.2');
  assert(!satisfies('8.2.2', '<=6.4.2'), 'vite 8.2.2 must NOT be flagged by <=6.4.2');
  assert(satisfies('5.4.21', '<=6.4.2'), 'vite 5.4.21 must be flagged by <=6.4.2');
  assert(satisfies('1.2.3', '>=1.0.0 <2.0.0'), 'AND range');
  assert(!satisfies('2.0.1', '>=1.0.0 <2.0.0'), 'AND range upper bound');
  assert(satisfies('3.1.0', '2.x || 3.x'), 'OR range');
  assert(satisfies('9.9.9', 'garbage range'), 'unparseable range must fail closed');

  const entries = lockEntries(
    parseLock(`{ "packages": {
      "esbuild": ["esbuild@0.25.12", "url", {}, "sha"],
      "vitepress/vite": ["vite@5.4.21", "url", {}, "sha"],
      "vitepress/vite/esbuild": ["esbuild@0.21.5", "url", {}, "sha"],
      "@esbuild-kit/core-utils/esbuild": ["esbuild@0.18.20", "url", {}, "sha"],
      "some-parent/@scope/tool": ["@scope/tool@1.0.0", "url", {}, "sha"]
    } }`),
  );
  assert(
    entries.some((e) => e.name === '@scope/tool' && e.version === '1.0.0' && e.chain === 'some-parent > @scope/tool'),
    'scoped package names and lock-key chains must parse',
  );
  const findings = findFindings(
    {
      esbuild: [{ url: 'https://github.com/advisories/GHSA-esbuild', severity: 'moderate', vulnerable_versions: '<=0.24.2' }],
      vite: [{ url: 'https://github.com/advisories/GHSA-vite-high', severity: 'high', vulnerable_versions: '<=6.4.2' }],
      '@scope/tool': [{ url: 'https://github.com/advisories/GHSA-tool', severity: 'critical', vulnerable_versions: '*' }],
    },
    entries,
  );
  const keys = findings.map((f) => `${f.package}@${f.version}@${f.chain}`).sort();
  assert(
    JSON.stringify(keys) ===
      JSON.stringify([
        '@scope/tool@1.0.0@some-parent > @scope/tool',
        'esbuild@0.18.20@@esbuild-kit/core-utils > esbuild',
        'esbuild@0.21.5@vitepress > vite > esbuild',
        'vite@5.4.21@vitepress > vite',
      ]),
    `finding extraction mismatch: ${JSON.stringify(keys)}`,
  );
  assert(!keys.some((k) => k.startsWith('esbuild@0.25')), 'the safe esbuild 0.25 copy must not be flagged');

  const esbuildKit = findings.find((f) => f.version === '0.18.20');
  const tool = findings.find((f) => f.package === '@scope/tool');
  const good = {
    url: 'https://github.com/advisories/GHSA-esbuild',
    version: '0.18.20',
    chain: '@esbuild-kit/core-utils > esbuild',
    reason: 'drizzle-kit 0.31 pins @esbuild-kit/core-utils ~0.18',
    exposure: 'local migration generation only, dev tooling, no network surface',
    owner: 'platform-team',
    expires: '2099-01-01',
  };
  const rest = checkExceptions(findings, [good]);
  assert(rest.length === 3 && rest.some((e) => e.includes('vite@5.4.21')), 'a moderate exception defers only its own chain; the vite high must stay fatal');
  assert(
    checkExceptions([esbuildKit], [{ ...good, expires: '2000-01-01' }]).some((e) => e.includes('expired')),
    'expired exceptions must fail',
  );
  assert(
    checkExceptions([esbuildKit], [{ ...good, version: '0.25.12' }]).some((e) => e.includes('matches no current finding')),
    'widening a version must fail',
  );
  assert(
    checkExceptions([tool], [{ ...good, url: tool.url, version: '1.0.0', chain: tool.chain }]).some((e) => e.includes('cannot be excepted')),
    'critical findings must never be excepted',
  );
  assert(
    checkExceptions([esbuildKit], [{ ...good, owner: '' }]).some((e) => e.includes('missing')),
    'missing metadata must fail',
  );
  console.log('✓ check-audit self-test passed');
}

/* -------------------------------------------------------------------------- */
function main() {
  if (process.argv.includes('--self-test')) return selfTest();

  const audit = spawnSync('bun', ['audit', '--json', '--registry', REGISTRY], {
    encoding: 'utf8',
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let advisories;
  try {
    advisories = JSON.parse(audit.stdout);
  } catch {
    const detail = (audit.stderr || audit.stdout || '').trim().split('\n').slice(-3).join('\n');
    console.error(`✗ \`bun audit --registry ${REGISTRY}\` failed (exit ${audit.status})\n${detail}`);
    process.exit(1);
  }

  const findings = findFindings(advisories, lockEntries(parseLock(readFileSync(lockfile, 'utf8'))));
  const exceptions = loadExceptions(exceptionsFile);
  const errors = checkExceptions(findings, exceptions);

  for (const error of errors) console.error(`✗ ${error}`);
  if (errors.length > 0) {
    console.error('\n  Fix the chains in bun.lock, or (moderate only) add a narrow');
    console.error('  advisory+version+chain exception to scripts/audit-exceptions.json.');
    process.exit(1);
  }
  console.log(
    `✓ audit clean against ${REGISTRY} — ${findings.length} finding(s), ` +
      `${exceptions.length} exception(s) verified`,
  );
}

main();
