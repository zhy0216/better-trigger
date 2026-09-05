/* Offline fixtures are synthetic: they demonstrate parser/process behavior,
 * not a claim that a real advisory was missed. Run through the CI entry:
 *   bun run check:audit -- --self-test
 *
 * Bun 1.4.0 was also checked against registry.npmjs.org: the repository's
 * clean lock returned status 0 and {}; a disposable lock containing only
 * esbuild@0.18.20 returned status 1 and an advisory with id, url, title,
 * severity, vulnerable_versions (plus unused cwe/cvss metadata).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { satisfies as semverSatisfies } from 'semver';
import {
  AUDIT_TIMEOUT_MS,
  REGISTRY,
  checkExceptions,
  findFindings,
  lockEntries,
  main,
  parseAuditResult,
  parseLock,
  satisfies,
} from './check-audit.mjs';

const advisory = (fields = {}) => ({
  id: 123456,
  url: 'https://github.com/advisories/GHSA-synthetic',
  title: 'Synthetic offline advisory',
  severity: 'moderate',
  vulnerable_versions: '<2.0.0',
  ...fields,
});
const result = (report = {}, fields = {}) => ({
  status: 0,
  signal: null,
  stdout: JSON.stringify(report),
  stderr: '',
  ...fields,
});
const report = (fields = {}) => ({ demo: [advisory(fields)] });
// Observed with Bun 1.4.0 audit AND pm hash, including NODE_ENV unset,
// development, production, test and staging: package commands load this group.
const loadedEnvFiles = ['.env.production.local', '.env.local', '.env.production', '.env'];
const envFiles = ['.env', '.env.local', ...['development', 'production', 'test']
  .flatMap((mode) => [`.env.${mode}`, `.env.${mode}.local`])];
const dotenvScenarios = [
  { name: 'no-env', files: [], loaded: [] },
  ...envFiles.map((file) => ({
    name: file, files: [file], mode: file.match(/\.(development|production|test)/)?.[1],
    loaded: loadedEnvFiles.includes(file) ? [file] : [],
  })),
  ...[undefined, 'development', 'production', 'test', 'staging'].map((mode) => ({
    name: `all-${mode ?? 'unset'}`, files: envFiles, mode, loaded: loadedEnvFiles,
  })),
];
const dotenvNotices = [
  '[0.05ms] ".env"\n', '[12.34ms] ".env"\n', '[1000.00ms] ".env"\r\n',
  ...dotenvScenarios.filter(({ loaded }) => loaded.length > 0)
    .map(({ loaded }) => `[0.05ms] ${loaded.map((file) => JSON.stringify(file)).join(', ')}\n`),
  '[0.05ms] ".env.local", ".env"\n',
];
const fixtureLock = JSON.stringify({ packages: { demo: ['demo@1.0.0', '', {}, ''] } });
const now = new Date('2030-06-01T12:00:00Z');
const exception = (fields = {}) => ({
  url: advisory().url,
  version: '1.0.0',
  chain: 'demo',
  reason: 'Synthetic temporary deferral',
  exposure: 'Offline fixture only',
  owner: 'audit-test',
  expires: '2030-06-02',
  ...fields,
});

// Unknown terms before/after false AND terms, true OR terms, wildcard OR
// groups and SemVer's empty-set simplification must ALL be parsed first.
const invalidRanges = [
  '<2.0.0 garbage', 'garbage <2.0.0', '>=1.0.0 garbage <2.0.0',
  '<2.0.0 garbage >=1.0.0', '<2.0.0 || garbage', 'garbage || <2.0.0',
  '>=1.0.0 || garbage', 'garbage || >=1.0.0', '* || garbage', 'garbage || *',
  '<2.0.0 || garbage || >=1.0.0', '>=1.0.0 || <2.0.0 garbage',
  '<0.0.0-0 garbage', '>3.0.0 || <0.0.0-0 garbage',
  '<2.0.0 +garbage', '+garbage <2.0.0', '<2.0.0 +foo +bar',
  '>=1.0.0 || +garbage', '+garbage || >=1.0.0',
  '>=1.0.0 || <2.0.0 +garbage', '<2.0.0 +garbage || >=1.0.0',
  '<2.0.0+build+more', '1.x+build', '1.2.3+foo.', '1.2.3+.foo', '1.2.3+foo..bar',
  '<2.0.0*', '<2.0*.0', '<2.0.0 *garbage', '*garbage <2.0.0',
  '>=1.0.0 || <2.0.0*', '<2.0.0* || >=1.0.0', '1.2.*-beta',
  '!=1.0.0', '=>1.0.0', '>=1.0.0, <2.0.0', '1.2.3.4',
  '1.2.3-01', '>=9007199254740992.0.0', '', ' ', '||',
  '<2.0.0 ||', '|| >=1.0.0', '>=1.0.0 || || <2.0.0', null, [], 123,
];

const badProcesses = [
  ['exit-2-clean-json', result({}, { status: 2 }), /exit 2/],
  ['exit-2-valid-report', result(report(), { status: 2 }), /exit 2/],
  ['signal-with-json', result({}, { signal: 'SIGTERM' }), /signal SIGTERM/],
  ['enoent-with-json', result({}, { error: { code: 'ENOENT', message: 'missing bun' } }), /ENOENT/],
  ['timeout-with-json', result({}, { error: { code: 'ETIMEDOUT', message: 'timeout' } }), /ETIMEDOUT/],
  ['buffer-overflow-with-json', result({}, { error: { code: 'ENOBUFS', message: 'maxBuffer exceeded' } }), /ENOBUFS/],
  ['no-exit-status', result({}, { status: null }), /exit null/],
  ['string-exit-status', result({}, { status: '0' }), /exit 0/],
  ['failure-without-report', result({}, { status: 1 }), /without an advisory report/],
  ['stderr-with-clean-json', result({}, { stderr: 'audit request failed' }), /stderr/],
  ['stderr-with-valid-report', result(report(), { status: 1, stderr: 'partial audit failure' }), /stderr/],
  ...[
    null, undefined, Buffer.from(''),
    `${dotenvNotices[0]}warning: partial response\n`,
    `warning: partial response\n${dotenvNotices[0]}`,
    '[0.05ms] ".env" warning: partial response\n',
    '[0.05ms] ".env"\rwarning: partial response\n',
    `${dotenvNotices[0]}${dotenvNotices[0]}`,
    '[0.05ms] "error.log"\n', '[0.05ms] ".env.staging"\n',
    '[0.05ms] ".env.development"\n', '[0.05ms] ".env.test"\n',
    '[0.05ms] ".env", ".env.local"\n', '[0.05ms] ".env", ".env"\n',
    '[0.05ms] ".env.local", "error.log", ".env"\n',
    '[0.05ms] ".env.local", ".env", warning\n',
    '[0.05ms] ".env" extra\n', '[0.05ms] ".env"',
    'prefix [0.05ms] ".env"\n', ' [0.05ms] ".env"\n',
    '[-0.05ms] ".env"\n', '[NaNms] ".env"\n',
    '[0x05ms] ".env"\n', '[0.05s] ".env"\n',
    '[0.05ms] "xenv"\n', '[0.05ms] ".env"\u0000\n',
  ].map((stderr, index) => [`stderr-near-miss-${index}`, result({}, { stderr }), /stderr/]),
  ['invalid-json', result({}, { stdout: '{' }), /invalid JSON/],
  ['empty-output', result({}, { stdout: '' }), /invalid JSON/],
  ['array-response', result([]), /expected a package advisory object/],
  ['null-response', result(null), /expected a package advisory object/],
  ['boolean-response', result(true), /expected a package advisory object/],
  ['number-response', result(123), /expected a package advisory object/],
  ['error-response', result({ error: { code: 'E500', message: 'registry failed' } }), /advisory array/],
  ['empty-error-array', result({ error: [] }), /nonempty advisory array/],
  ['null-package-advisories', result({ demo: null }), /advisory array/],
  ['object-package-advisories', result({ demo: advisory() }), /advisory array/],
  ['empty-package-name', result({ '': [advisory()] }), /advisory array/],
  ['null-advisory', result({ demo: [null] }), /expected an object/],
  ['array-advisory', result({ demo: [[]] }), /expected an object/],
  ['invalid-second-advisory', result({ demo: [advisory(), null] }), /demo\[1\]/],
  ...['id', 'url', 'title', 'severity', 'vulnerable_versions'].map((field) => [
    `missing-${field}`, result(report({ [field]: undefined })), new RegExp(field),
  ]),
  ['string-id', result(report({ id: '123' })), /id/],
  ['fractional-id', result(report({ id: 1.5 })), /id/],
  ['zero-id', result(report({ id: 0 })), /id/],
  ['negative-id', result(report({ id: -1 })), /id/],
  ['unsafe-id', result(report({ id: Number.MAX_SAFE_INTEGER + 1 })), /id/],
  ['empty-title', result(report({ title: ' ' })), /title/],
  ['numeric-title', result(report({ title: 123 })), /title/],
  ['unknown-severity', result(report({ severity: 'urgent' })), /severity/],
  ['uppercase-severity', result(report({ severity: 'HIGH' })), /severity/],
  ['relative-url', result(report({ url: '/advisory' })), /url/],
  ['script-url', result(report({ url: 'javascript:alert(1)' })), /url/],
  ['unresolved-package', result({ absent: [advisory()] }, { status: 1 }), /absent from bun.lock/],
  ['invalid-range-without-lock-match', result({ absent: [advisory({ vulnerable_versions: '<2.0.0 garbage' })] }), /invalid advisory range/],
  ...invalidRanges.map((range, index) => [
    `invalid-range-${index}`, result(report({ vulnerable_versions: range }), { status: 1 }), /invalid.*(range|vulnerable_versions)/,
  ]),
];

// A startup notice must not hide ANY existing process/JSON/schema/range failure.
badProcesses.push(...badProcesses.map(([name, audit, diagnostic]) => [
  `${name}-with-dotenv`,
  { ...audit, stderr: dotenvNotices[0] + (typeof audit.stderr === 'string' ? audit.stderr : 'invalid stderr') },
  diagnostic,
]));

function runFixture(audit, overrides = {}) {
  const logs = [];
  const errors = [];
  const status = main({
    spawn: () => audit,
    readLock: () => fixtureLock,
    readExceptions: () => [],
    now,
    log: (message) => logs.push(message),
    error: (message) => errors.push(message),
    ...overrides,
  });
  return { status, logs, errors };
}

// Every file is created by this test. Never copy or inspect a checkout's .env.
// The minimal child environment excludes database URLs and registry credentials.
function withDotenvFixtures(check, live = false) {
  const directory = mkdtempSync(join(tmpdir(), 'check-audit-dotenv-'));
  const root = fileURLToPath(new URL('..', import.meta.url));
  try {
    if (live) {
      mkdirSync(join(directory, 'scripts'));
      for (const file of ['package.json', 'bun.lock', 'scripts/check-audit.mjs', 'scripts/check-audit.test.mjs']) {
        copyFileSync(join(root, file), join(directory, file));
      }
      const exceptions = 'scripts/audit-exceptions.json';
      if (existsSync(join(root, exceptions))) copyFileSync(join(root, exceptions), join(directory, exceptions));
      symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'junction');
    } else {
      writeFileSync(join(directory, 'package.json'), '{"name":"audit-dotenv-fixture","private":true}');
      writeFileSync(join(directory, 'bun.lock'), JSON.stringify({
        lockfileVersion: 1, configVersion: 1,
        workspaces: { '': { name: 'audit-dotenv-fixture' } }, packages: {},
      }));
    }
    for (const scenario of dotenvScenarios) {
      for (const file of envFiles) rmSync(join(directory, file), { force: true });
      for (const [index, file] of scenario.files.entries()) {
        writeFileSync(join(directory, file), `AUDIT_DOTENV_FIXTURE_${index}=synthetic\n`);
      }
      check(scenario, {
        cwd: directory,
        env: { PATH: process.env.PATH, ...(scenario.mode ? { NODE_ENV: scenario.mode } : {}) },
        encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL',
      });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(existsSync(directory), false, 'synthetic dotenv fixture must be cleaned');
}

function assertDotenvOutput(child, scenario) {
  assert.ifError(child.error);
  assert.equal(child.signal, null, scenario.name);
  assert.equal(child.status, 0, `${scenario.name}: ${child.stderr}`);
  if (scenario.loaded.length === 0) {
    assert.equal(child.stderr, '', scenario.name);
  } else {
    assert.match(child.stderr, /^\[\d+\.\d{2}ms\] /, scenario.name);
    assert.equal(child.stderr.replace(/^\[\d+\.\d{2}ms\] /, ''),
      `${scenario.loaded.map((file) => JSON.stringify(file)).join(', ')}\n`, scenario.name);
  }
}

// Opt-in online regression: real registry response and unmodified package-script
// entry point in disposable checkouts, including self-test with and without .env.
// Run: bun scripts/check-audit.test.mjs --live-test
function liveTest() {
  withDotenvFixtures((scenario, options) => {
    const audit = spawnSync('bun', ['audit', '--json', '--registry', REGISTRY], options);
    assertDotenvOutput(audit, scenario);
    parseAuditResult(audit);
    const commands = [['run', 'check:audit']];
    if (['no-env', '.env'].includes(scenario.name)) commands.push(['run', 'check:audit', '--', '--self-test']);
    for (const args of commands) {
      const child = spawnSync('bun', args, options);
      assert.ifError(child.error);
      assert.equal(child.signal, null, scenario.name);
      assert.equal(child.status, 0, `${scenario.name}: ${child.stdout}\n${child.stderr}`);
      assert.match(child.stdout, args.includes('--self-test') ? /self-test passed/ : /audit clean/);
      console.log(`✓ ${scenario.name}: bun ${args.join(' ')}`);
    }
    console.log(JSON.stringify({ scenario: scenario.name, status: audit.status, stdout: audit.stdout, stderr: audit.stderr }));
  }, true);
  console.log(`✓ check-audit live-test passed — ${dotenvScenarios.length} dotenv scenarios; fixtures cleaned`);
}

export function selfTest() {
  for (const [name, audit, diagnostic] of badProcesses) {
    const outcome = runFixture(audit);
    assert.equal(outcome.status, 1, `${name} must fail`);
    assert.equal(outcome.logs.length, 0, `${name} must not print success`);
    assert.match(outcome.errors.join('\n'), diagnostic, name);
  }
  for (const stderr of ['', ...dotenvNotices]) {
    const clean = runFixture(result({}, { stderr }));
    assert.equal(clean.status, 0, `clean report with stderr ${JSON.stringify(stderr)}`);
    assert.equal(clean.errors.length, 0);
    assert.match(clean.logs.join('\n'), /audit clean.*0 finding/);

    for (const status of [0, 1]) {
      // A valid report is evaluated regardless of the accepted Bun status.
      assert.equal(runFixture(result(report(), { status, stderr })).status, 1);
      const deferred = runFixture(result(report(), { status, stderr }), { readExceptions: () => [exception()] });
      assert.equal(deferred.status, 0);
      assert.match(deferred.logs.join('\n'), /1 finding\(s\), 1 exception\(s\) verified/);
      assert.equal(runFixture(result(report({ vulnerable_versions: '<1.0.0' }), { status, stderr })).status, 0);
    }
  }
  // pm hash uses Bun's package-manager dotenv startup path without networking.
  // Feed its real stderr into both clean reports and mixed-diagnostic failures.
  withDotenvFixtures((scenario, options) => {
    const startup = spawnSync('bun', ['pm', 'hash'], options);
    assertDotenvOutput(startup, scenario);
    assert.equal(runFixture(result({}, { stderr: startup.stderr })).status, 0, scenario.name);
    for (const stderr of [`${startup.stderr}warning: partial audit\n`, `warning: partial audit\n${startup.stderr}`]) {
      assert.throws(() => parseAuditResult(result({}, { stderr })), /stderr/, scenario.name);
    }
  });
  const thrown = runFixture(result(), { spawn: () => { throw new Error('spawn failed'); } });
  assert.equal(thrown.status, 1);
  assert.match(thrown.errors.join('\n'), /spawn failed/);
  let called = false;
  assert.equal(runFixture(result(), {
    spawn: (command, args, options) => {
      called = true;
      assert.equal(command, 'bun');
      assert.deepEqual(args, ['audit', '--json', '--registry', 'https://registry.npmjs.org']);
      assert.equal(REGISTRY, 'https://registry.npmjs.org');
      assert.equal(options.cwd, fileURLToPath(new URL('..', import.meta.url)));
      assert.equal(options.encoding, 'utf8');
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      assert.equal(options.timeout, AUDIT_TIMEOUT_MS);
      assert.equal(AUDIT_TIMEOUT_MS, 60_000);
      assert.equal(options.killSignal, 'SIGKILL');
      assert.equal(options.maxBuffer, 10 * 1024 * 1024);
      return result();
    },
  }).status, 0);
  assert.equal(called, true);

  // A real timed-out child with parseable stdout must also be refused.
  const timedOut = spawnSync('bun', ['-e', 'process.stdout.write("{}"); setInterval(() => {}, 1000)'], {
    encoding: 'utf8', timeout: 500, killSignal: 'SIGKILL',
  });
  assert.equal(timedOut.stdout, '{}');
  assert.ok(timedOut.error || timedOut.signal);
  assert.throws(() => parseAuditResult(timedOut), /process error|signal/);

  // Exercise actual exit codes, not just thrown errors/returned booleans.
  // These children inject data into the same main() as the production CLI;
  // the production CLI has no fixture/env switch that could bypass audit.
  for (const [name, , diagnostic] of badProcesses) {
    const child = spawnSync('bun', [fileURLToPath(import.meta.url), '--fixture', name], {
      encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL',
    });
    assert.ifError(child.error);
    assert.equal(child.signal, null, name);
    assert.equal(child.status, 1, `${name}: ${child.stderr}`);
    assert.equal(child.stdout, '', name);
    assert.match(child.stderr, diagnostic, name);
  }

  const ranges = [
    ['0.18.20', '<=0.24.2', true], ['0.24.2', '<=0.24.2', true], ['0.25.12', '<=0.24.2', false],
    ['8.2.2', '<=6.4.2', false], ['5.4.21', '<=6.4.2', true],
    ['1.0.0', '>=1.0.0 <2.0.0', true], ['1.9.9', '>=1.0.0 <2.0.0', true],
    ['2.0.0', '>=1.0.0 <2.0.0', false], ['2.0.1', '>=1.0.0 <2.0.0', false],
    ['1.0.0', '>1.0.0', false], ['1.0.1', '>1.0.0', true], ['1.0.0', '<1.0.0', false],
    ['1.2.3', '=1.2.3', true], ['1.2.4', '1.2.3', false],
    ['3.1.0', '2.x || 3.x', true], ['4.0.0', '2.x || 3.x', false],
    ['1.2.9', '1.2.x', true], ['1.3.0', '1.2.x', false], ['2.0.0', '1.*', false],
    ['1.9.0', '1.x.x', true], ['9.9.9', '*', true], ['9.9.9', 'x', true],
    ['1.2.3', '>= 1.0.0 < 2.0.0', true], ['1.2.3', '^1.2.0', true],
    ['2.0.0', '^1.2.0', false], ['1.3.0', '~1.2.0', false],
    ['2.3.4', '1.2.3 - 2.3.4', true], ['2.3.5', '1.2.3 - 2.3.4', false],
    ['1.2.3-beta.1', '*', true], ['1.5.0-beta.1', '>=1.0.0 <2.0.0', true],
    ['1.0.0-beta.1', '>=1.0.0', false], ['1.0.0-beta.1', '1.x', true],
    ['2.0.0-beta.1', '1.x', false], ['1.2.0-beta.1', '~1.2.0', false],
    ['2.0.0-rc.1', '<2.0.0', true], ['2.0.0-rc.1', '>=2.0.0', false],
    ['2.0.0-rc.1', '=2.0.0', false], ['2.0.0', '=2.0.0-rc.1', false],
    ['1.2.3-beta.2', '>=1.2.3-beta.2 <1.2.3', true],
    ['1.2.3-beta.10', '>1.2.3-beta.2 <1.2.3', true],
    ['1.2.3-beta.2', '>1.2.3-beta.10', false],
    ['1.2.3-alpha', '<1.2.3-beta', true], ['1.2.3-beta.1', '<1.2.3-beta', false],
    ['1.2.3-beta.1+build.2', '=1.2.3-beta.1+other', true],
    ['1.2.3+build.1', '=1.2.3+other', true],
    ['1.2.3+build.1', '>= 1.2.3+other <2.0.0+fix', true],
    ['1.2.3+build.1', '^1.2.0+other', true], ['1.2.3+build.1', '~1.2.0+other', true],
    ['1.2.3+build.1', '1.2.0+other - 1.3.0+fix', true],
  ];
  for (const [version, range, expected] of ranges) {
    assert.equal(satisfies(version, range), expected, `${version} / ${range}`);
  }
  assert.equal(semverSatisfies('1.5.0-beta.1', '>=1.0.0 <2.0.0'), false, 'verify library default exclusion');
  for (const range of invalidRanges) {
    assert.throws(() => satisfies('3.0.0', range), /invalid advisory range/, `${range}`);
  }
  const hiddenInvalidRange = runFixture(result(report({ vulnerable_versions: '<2.0.0 garbage' }), { status: 1 }), {
    readLock: () => JSON.stringify({ packages: { demo: ['demo@3.0.0', '', {}, ''] } }),
  });
  assert.equal(hiddenInvalidRange.status, 1);
  assert.match(hiddenInvalidRange.errors.join('\n'), /invalid advisory range/);
  for (const version of ['garbage', '1.2', '1.2.3-01', '9007199254740992.0.0', '', null]) {
    assert.throws(() => satisfies(version, '<0.0.0'), /[Ii]nvalid/, `invalid resolved version ${version}`);
  }

  const entries = lockEntries(parseLock(`{ "packages": {
    "esbuild": ["esbuild@0.25.12", "url", {}, "sha"],
    "vitepress/vite": ["vite@5.4.21", "url", {}, "sha"],
    "vitepress/vite/esbuild": ["esbuild@0.21.5", "url", {}, "sha"],
    "@esbuild-kit/core-utils/esbuild": ["esbuild@0.18.20", "url", {}, "sha"],
    "other/esbuild": ["esbuild@0.18.20", "url", {}, "sha"],
    "some-parent/@scope/tool": ["@scope/tool@1.0.0", "url", {}, "sha"],
  }, }`));
  const findings = findFindings({
    esbuild: [advisory({ vulnerable_versions: '<=0.24.2' })],
    vite: [advisory({ url: 'https://example.com/vite', severity: 'high', vulnerable_versions: '<=6.4.2' })],
    '@scope/tool': [advisory({ url: 'https://example.com/tool', severity: 'critical', vulnerable_versions: '*' })],
  }, entries);
  assert.deepEqual(findings.map((f) => `${f.package}@${f.version}@${f.chain}`).sort(), [
    '@scope/tool@1.0.0@some-parent > @scope/tool',
    'esbuild@0.18.20@@esbuild-kit/core-utils > esbuild',
    'esbuild@0.18.20@other > esbuild',
    'esbuild@0.21.5@vitepress > vite > esbuild',
    'vite@5.4.21@vitepress > vite',
  ]);
  const good = exception({ version: '0.18.20', chain: '@esbuild-kit/core-utils > esbuild' });
  const rest = checkExceptions(findings, [good], now);
  assert.equal(rest.length, 4);
  assert.ok(rest.some((message) => message.includes('other > esbuild')), 'same version, different chain remains fatal');
  const finding = findings.find((f) => f.chain === good.chain);
  for (const severity of ['low', 'moderate']) {
    assert.deepEqual(checkExceptions([{ ...finding, severity }], [good], now), []);
  }
  for (const severity of ['high', 'critical']) {
    assert.match(checkExceptions([{ ...finding, severity }], [good], now).join('\n'), /cannot be excepted/);
  }
  for (const field of ['url', 'version', 'chain']) {
    assert.match(checkExceptions([finding], [{ ...good, [field]: 'different' }], now).join('\n'), /matches no current finding/);
  }
  for (const field of ['url', 'version', 'chain', 'reason', 'exposure', 'owner', 'expires']) {
    assert.match(checkExceptions([finding], [{ ...good, [field]: ' ' }], now).join('\n'), /missing/);
  }
  assert.match(checkExceptions([], [good], now).join('\n'), /matches no current finding/);
  assert.match(checkExceptions([finding], [{ ...good, expires: '2030-05-31' }], now).join('\n'), /expired/);
  assert.match(checkExceptions([finding], [{ ...good, expires: 'not-a-date' }], now).join('\n'), /not an ISO date/);
  assert.deepEqual(checkExceptions([finding], [{ ...good, expires: '2030-06-01' }], now), []);
  assert.equal(runFixture(result(report()), { readExceptions: () => [exception({ expires: '2000-01-01' })] }).status, 1);
  assert.equal(runFixture(result(report({ severity: 'high' })), { readExceptions: () => [exception()] }).status, 1);
  assert.equal(runFixture(result(), { readExceptions: () => [exception()] }).status, 1);
  console.log(`✓ check-audit self-test passed — ${badProcesses.length} rejected fixtures (including child exit checks), ${ranges.length} range cases, ${dotenvScenarios.length} real offline dotenv scenarios (cleaned), process/lock/exception checks`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--live-test')) {
    liveTest();
  } else {
    const name = process.argv[process.argv.indexOf('--fixture') + 1];
    const fixture = badProcesses.find(([candidate]) => candidate === name);
    assert.ok(fixture, `unknown fixture ${name}`);
    process.exitCode = main({ spawn: () => fixture[1], readLock: () => fixtureLock, readExceptions: () => [], now });
  }
}
