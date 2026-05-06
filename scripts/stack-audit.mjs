import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { scanArtifactDenylist, writeArtifactDenylistReport } from './qa-helpers.mjs';
import { appRoutes, screenshotRoutes } from '../src/routes/routeManifest.ts';
import { executableReleaseGateDefinitions } from '../src/lib/releaseGateManifest.ts';

const execFileAsync = promisify(execFile);
const requiredVisualRoutes = new Map([
  ['/calculators', 'calculators'],
  ['/formulas', 'formulas'],
  ['/quant/risk-management', 'quant risk-management'],
  ['/excel/dcf-modeling', 'excel dcf modeling'],
]);

function hasFlag(flag) {
  return process.argv.slice(2).includes(flag);
}

async function npmAudit() {
  try {
    const { stdout } = await execFileAsync('npm', ['audit', '--omit=dev', '--json'], {
      cwd: process.cwd(),
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 8,
    });
    return { status: 'ok', raw: JSON.parse(stdout || '{}') };
  } catch (error) {
    const stdout = error?.stdout?.toString?.() || '{}';
    try {
      return { status: 'blocked', raw: JSON.parse(stdout) };
    } catch {
      return { status: 'blocked', raw: { error: error instanceof Error ? error.message : String(error) } };
    }
  }
}

function auditVulnerabilities(raw) {
  const vulnerabilities = raw?.metadata?.vulnerabilities || {};
  return Object.entries(vulnerabilities)
    .filter(([severity]) => severity !== 'info' && severity !== 'total')
    .reduce((sum, [, count]) => sum + Number(count || 0), 0);
}

async function packageScriptChecks() {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const requiredScripts = [
    'audit',
    'cfa:source:audit',
    'content:validate',
    'stack:audit',
    'browser:regression',
    'visual:regression',
    'a11y:check',
    'release:gates',
    'release:checklist',
  ];
  const missing = requiredScripts.filter((script) => !pkg.scripts?.[script]);
  const engines = {
    node: pkg.engines?.node || null,
    npm: pkg.engines?.npm || null,
  };
  return {
    status: missing.length ? 'blocked' : 'ok',
    missing,
    engines,
    requiredScripts,
  };
}

async function structuralChecks() {
  const issues = [];
  const routeIds = new Set();
  const routePaths = new Set();
  appRoutes.forEach((route) => {
    if (routeIds.has(route.id)) issues.push(`Duplicate route id: ${route.id}`);
    routeIds.add(route.id);
    if (routePaths.has(route.path)) issues.push(`Duplicate route path: ${route.path}`);
    routePaths.add(route.path);
    if (route.offlineCritical && !route.smokeRoute && !route.screenshotRoute) {
      issues.push(`${route.id} is offline-critical but has no smoke or screenshot route.`);
    }
  });

  const screenshotPaths = new Set(screenshotRoutes.map((route) => route.path));
  requiredVisualRoutes.forEach((label, routePath) => {
    if (!screenshotPaths.has(routePath)) issues.push(`Missing visual coverage for ${label} (${routePath}).`);
  });
  screenshotRoutes.forEach((route) => {
    const viewports = new Set(route.viewports);
    if (!viewports.has('desktop') || !viewports.has('mobile')) {
      issues.push(`${route.id} screenshot coverage must include desktop and mobile.`);
    }
  });

  const serviceWorker = await readFile('src/sw.js', 'utf8');
  if (!serviceWorker.includes("request.mode === 'navigate'") && !serviceWorker.includes('request.mode === "navigate"')) {
    issues.push('Service worker is missing an explicit navigation fallback route.');
  }
  if (!serviceWorker.includes('OFFLINE_CONTENT_CACHE') || !serviceWorker.includes("caches.match('/index.html')")) {
    issues.push('Service worker navigation fallback must check the offline route cache and app shell.');
  }

  const gateIds = new Set(executableReleaseGateDefinitions.map((gate) => gate.id));
  ['verify', 'source-audit', 'stack-audit', 'browser-regression', 'visual-regression', 'accessibility'].forEach((id) => {
    if (!gateIds.has(id)) issues.push(`Executable release gate is missing: ${id}`);
  });

  return {
    status: issues.length ? 'blocked' : 'ok',
    issues,
    routes: appRoutes.length,
    screenshotRoutes: screenshotRoutes.length,
    executableGates: executableReleaseGateDefinitions.length,
  };
}

const artifactOnly = hasFlag('--artifact-only');
const generatedAt = new Date().toISOString();
const artifactDenylist = await scanArtifactDenylist({ includeTracked: !artifactOnly });
await writeArtifactDenylistReport(artifactDenylist);

const scriptChecks = artifactOnly ? null : await packageScriptChecks();
const structure = artifactOnly ? null : await structuralChecks();
const dependencyAudit = artifactOnly ? null : await npmAudit();
const prodVulnerabilityCount = dependencyAudit ? auditVulnerabilities(dependencyAudit.raw) : 0;
const dependencyAuditBlocked = Boolean(dependencyAudit?.raw?.error) || prodVulnerabilityCount > 0;

const checks = [
  {
    id: 'artifact-denylist',
    status: artifactDenylist.status,
    detail: artifactDenylist.violations.length
      ? `${artifactDenylist.violations.length} denied artifact(s) detected.`
      : `${artifactDenylist.scannedFiles} file(s) passed artifact denylist checks.`,
  },
  ...(scriptChecks
    ? [
        {
          id: 'package-scripts',
          status: scriptChecks.status,
          detail: scriptChecks.missing.length ? `Missing scripts: ${scriptChecks.missing.join(', ')}` : 'Required QA/release scripts are wired.',
        },
      ]
    : []),
  ...(structure
    ? [
        {
          id: 'route-pwa-structure',
          status: structure.status,
          detail: structure.issues.length
            ? `${structure.issues.length} structural issue(s): ${structure.issues.slice(0, 3).join('; ')}${structure.issues.length > 3 ? '; ...' : ''}`
            : `${structure.routes} routes, ${structure.screenshotRoutes} screenshot route(s), and ${structure.executableGates} executable gate(s) are structurally aligned.`,
        },
      ]
    : []),
  ...(dependencyAudit
    ? [
        {
          id: 'production-dependency-audit',
          status: dependencyAuditBlocked ? 'blocked' : 'ok',
          detail: `${prodVulnerabilityCount} production vulnerability finding(s).`,
        },
      ]
    : []),
];

const report = {
  generatedAt,
  artifactOnly,
  runtime: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  checks,
  packageScripts: scriptChecks,
  structure,
  dependencyAudit: dependencyAudit
    ? {
        status: dependencyAuditBlocked ? 'blocked' : 'ok',
        commandStatus: dependencyAudit.status,
        vulnerabilities: dependencyAudit.raw?.metadata?.vulnerabilities || {},
      }
    : null,
  artifactDenylist,
  status: checks.some((check) => check.status !== 'ok') ? 'blocked' : 'ok',
};

await mkdir('dist/reports', { recursive: true });
await writeFile('dist/reports/stack-audit.json', `${JSON.stringify(report, null, 2)}\n`);

checks.forEach((check) => console.log(`${check.status.toUpperCase()} ${check.id}: ${check.detail}`));
if (report.status !== 'ok') {
  console.error('Stack audit blocked release.');
  process.exitCode = 1;
} else {
  console.log('Stack audit passed.');
}
