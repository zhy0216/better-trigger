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
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Range, SemVer } from 'semver';

export const REGISTRY = 'https://registry.npmjs.org';
export const AUDIT_TIMEOUT_MS = 60_000;
const root = fileURLToPath(new URL('..', import.meta.url));
const lockfile = `${root}bun.lock`;
const exceptionsFile = `${root}scripts/audit-exceptions.json`;

/** Advisory policy: include prereleases in SemVer ordering, without dropping
 *  their suffixes. E.g. 2.0.0-rc.1 is below a <2.0.0 fix boundary. Build
 *  metadata does not affect precedence. npm's default prerelease exclusion
 *  is for dependency selection, not this conservative vulnerability gate.
 *  https://github.com/npm/node-semver#prerelease-tags
 *
 *  Strict Range construction parses ALL AND/OR terms before any matching.
 *  Never use semver.satisfies directly: it returns false for invalid ranges.
 *  Empty groups are rejected even though npm treats them as wildcards. */
function parseAdvisoryRange(range) {
  if (typeof range !== 'string' || range.split('||').some((group) => !group.trim())) {
    throw new Error('invalid advisory range: expected nonempty comparator groups');
  }
  try {
    // semver 7.8.5 strips build metadata and stars before comparator parsing,
    // even in malformed terms such as "+garbage" or "2.0.0*". Validate their
    // placement first so that normalization cannot hide an invalid term.
    // Metadata on partial/wildcard versions is deliberately refused.
    for (const token of range.split(/\s+|\|\|/)) {
      const version = token.replace(/^(?:[<>]=?|=|~>?|\^)/, '');
      if (token.includes('+')) new SemVer(version);
      if (token.includes('*') && !/^v?(?:\d+|[xX*])(?:\.(?:\d+|[xX*])){0,2}$/.test(version)) {
        throw new Error(`invalid wildcard comparator ${JSON.stringify(token)}`);
      }
    }
    return new Range(range, { loose: false, includePrerelease: true });
  } catch (cause) {
    throw new Error(`invalid advisory range ${JSON.stringify(range)}: ${cause.message}`);
  }
}

export function satisfies(version, range) {
  const parsed = parseAdvisoryRange(range);
  // SemVer throws for invalid resolved versions; Range.test(string) would
  // silently return false and could hide a finding.
  return parsed.test(new SemVer(version));
}

const SEVERITIES = new Set(['low', 'moderate', 'high', 'critical']);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonemptyString = (value) => typeof value === 'string' && value.trim().length > 0;

/** npm's bulk advisory response is a package -> nonempty advisory array map.
 *  Validate the required identity/report fields even when no lock version
 *  matches. Extra registry metadata (e.g. cwe/cvss) is not used by the gate. */
function validateAdvisories(report) {
  if (!isRecord(report)) throw new Error('invalid audit response: expected a package advisory object');
  for (const [name, advisories] of Object.entries(report)) {
    if (!isNonemptyString(name) || !Array.isArray(advisories) || advisories.length === 0) {
      throw new Error(`invalid audit response for ${JSON.stringify(name)}: expected a nonempty advisory array`);
    }
    for (const [index, advisory] of advisories.entries()) {
      const label = `invalid advisory ${name}[${index}]`;
      if (!isRecord(advisory)) throw new Error(`${label}: expected an object`);
      if (!Number.isSafeInteger(advisory.id) || advisory.id <= 0) {
        throw new Error(`${label}: id must be a positive safe integer`);
      }
      for (const field of ['url', 'title', 'vulnerable_versions']) {
        if (!isNonemptyString(advisory[field])) throw new Error(`${label}: missing or invalid ${field}`);
      }
      let url;
      try { url = new URL(advisory.url); } catch { /* rejected below */ }
      if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
        throw new Error(`${label}: url must be an absolute HTTP(S) advisory URL without credentials`);
      }
      if (!SEVERITIES.has(advisory.severity)) throw new Error(`${label}: invalid severity`);
      try { parseAdvisoryRange(advisory.vulnerable_versions); } catch (cause) {
        throw new Error(`${label}: ${cause.message}`);
      }
    }
  }
  return report;
}

/** Bun 1.4.0 package commands print one dotenv timing line, even with
 *  --no-env-file. Accept only the observed default filenames in load order
 *  (including subsets); unknown names, duplicates and all other stderr remain
 *  diagnostics. NODE_ENV did not change this production group in audit/pm. */
function stripDotenvNotice(stderr) {
  const notice = /^\[\d+\.\d{2}ms\] ([^\r\n]+)\r?\n/.exec(stderr);
  if (!notice) return stderr;
  const loadOrder = ['".env.production.local"', '".env.local"', '".env.production"', '".env"'];
  let previous = -1;
  for (const file of notice[1].split(', ')) {
    const index = loadOrder.indexOf(file);
    if (index <= previous) return stderr;
    previous = index;
  }
  return stderr.slice(notice[0].length);
}

/** Bun 1.4.0 --json: clean is exit 0 + {}; vulnerabilities are exit 1 +
 *  the bulk advisory map. Request failures ALSO exit 1, so status alone is
 *  insufficient. Verified against the official registry with clean and
 *  esbuild@0.18.20 locks; see https://bun.sh/docs/pm/cli/audit#exit-code.
 *  Reject stderr diagnostics after the known dotenv startup notice: a
 *  partial/failed audit must never pass as clean. */
export function parseAuditResult(audit) {
  if (audit.error) {
    const code = audit.error.code ?? 'unknown';
    throw new Error(`bun audit process error (${code}): ${audit.error.message}`);
  }
  if (audit.signal) throw new Error(`bun audit terminated by signal ${audit.signal}`);
  if (audit.status !== 0 && audit.status !== 1) {
    throw new Error(`bun audit failed with exit ${audit.status}`);
  }
  if (typeof audit.stderr !== 'string' || stripDotenvNotice(audit.stderr).trim()) {
    throw new Error('bun audit produced stderr diagnostics; report may be incomplete');
  }
  let report;
  try { report = JSON.parse(audit.stdout); } catch {
    throw new Error('bun audit returned invalid JSON');
  }
  validateAdvisories(report);
  if (audit.status === 1 && Object.keys(report).length === 0) {
    throw new Error('bun audit exited 1 without an advisory report');
  }
  return report;
}

/** bun.lock is JSON with trailing commas; the only non-JSON bit to strip. */
export function parseLock(text) {
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
export function lockEntries(lock) {
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
export function findFindings(advisoriesByPackage, entries) {
  validateAdvisories(advisoriesByPackage);
  const findings = [];
  for (const [advisoryPackage, advisories] of Object.entries(advisoriesByPackage)) {
    const resolved = entries.filter((e) => e.name === advisoryPackage);
    if (resolved.length === 0) throw new Error(`audit package ${advisoryPackage} is absent from bun.lock`);
    for (const entry of resolved) {
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
export function checkExceptions(findings, exceptions, now = new Date()) {
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

/** Injectable process/file/output boundary shared by the CLI and offline tests.
 *  Only a completely validated process result and report can reach success. */
export function main({
  spawn = spawnSync,
  readLock = () => readFileSync(lockfile, 'utf8'),
  readExceptions = () => loadExceptions(exceptionsFile),
  now = new Date(),
  log = console.log,
  error = console.error,
} = {}) {
  try {
    const audit = spawn('bun', ['audit', '--json', '--registry', REGISTRY], {
      encoding: 'utf8',
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: AUDIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 10 * 1024 * 1024,
    });
    const advisories = parseAuditResult(audit);
    const findings = findFindings(advisories, lockEntries(parseLock(readLock())));
    const exceptions = readExceptions();
    const errors = checkExceptions(findings, exceptions, now);
    for (const message of errors) error(`✗ ${message}`);
    if (errors.length > 0) {
      error('Fix the chains in bun.lock, or add an exact low/moderate advisory+version+chain exception.');
      return 1;
    }
    log(`✓ audit clean against ${REGISTRY} — ${findings.length} finding(s), ${exceptions.length} exception(s) verified`);
    return 0;
  } catch (cause) {
    error(`✗ audit failed against ${REGISTRY}: ${cause.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--self-test')) {
    import('./check-audit.test.mjs')
      .then(({ selfTest }) => selfTest())
      .catch((cause) => {
        console.error(`✗ check-audit self-test: ${cause.stack ?? cause}`);
        process.exitCode = 1;
      });
  } else {
    process.exitCode = main();
  }
}
