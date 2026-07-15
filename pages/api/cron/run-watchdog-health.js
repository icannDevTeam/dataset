import admin from 'firebase-admin';
import { initializeFirebase } from '../../../lib/firebase-admin';
import { hikRequest, isAllowedDeviceIP } from '../../../lib/hikvision';
const tenancy = require('../../../lib/tenancy');

export const config = { api: { bodyParser: { sizeLimit: '8kb' } } };

const WATCHDOG_ENABLED = false;

const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_TERMINAL_GRACE_MS = 10 * 60 * 1000;
const DEFAULT_PROBE_TIMEOUT_MS = 8000;
const DEFAULT_LATENCY_THRESHOLD_MS = 600;
const DEFAULT_TERMINAL_DOWN_MIN_COUNT = 2;
const DEFAULT_TERMINAL_DOWN_MIN_RATIO = 0.5;

function parseMs(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function toIso(value) {
  return new Date(value).toISOString();
}

function toMs(value) {
  if (!value) return 0;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : 0;
}

function safeKey(key) {
  return String(key || '').replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
}

function parseBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function alertPolicy() {
  return {
    notifyRecovery: parseBool(process.env.WATCHDOG_NOTIFY_RECOVERY, false),
    notifyEmailQueue: parseBool(process.env.WATCHDOG_NOTIFY_EMAIL_QUEUE, false),
    notifySingleTerminal: parseBool(process.env.WATCHDOG_NOTIFY_TERMINAL_SINGLE, false),
    terminalDownMinCount: parseMs(process.env.WATCHDOG_TERMINAL_DOWN_MIN_COUNT, DEFAULT_TERMINAL_DOWN_MIN_COUNT),
    terminalDownMinRatio: Number(process.env.WATCHDOG_TERMINAL_DOWN_MIN_RATIO || DEFAULT_TERMINAL_DOWN_MIN_RATIO),
  };
}

function shouldEmailAlert(checkKey, eventType, policy) {
  if (eventType === 'recovery' && !policy.notifyRecovery) return false;
  if (checkKey === 'email_queue' && !policy.notifyEmailQueue) return false;
  if (checkKey.startsWith('terminal_')) return false;
  return true;
}

function authorize(req) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  const header = String(req.headers['authorization'] || '').trim();
  if (secret) {
    if (header === `Bearer ${secret}`) return true;
    if (header === secret) return true;
  }
  if (String(req.headers['x-vercel-cron'] || '').trim() === '1') return true;
  if (process.env.NODE_ENV !== 'production' && req.query?.dev === '1') return true;
  return false;
}

function resolveBaseUrl(req) {
  const preferred = String(process.env.WATCHDOG_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || '').trim();
  if (preferred) return preferred.replace(/\/$/, '');

  const vercel = String(process.env.VERCEL_URL || '').trim();
  if (vercel) {
    if (vercel.startsWith('http://') || vercel.startsWith('https://')) return vercel.replace(/\/$/, '');
    return `https://${vercel.replace(/\/$/, '')}`;
  }

  const host = String(req.headers.host || '').trim();
  if (!host) return null;
  const proto = String(req.headers['x-forwarded-proto'] || 'https').trim();
  return `${proto}://${host}`.replace(/\/$/, '');
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function listTenantIds(db) {
  const snap = await db.collection('tenants').get();
  const ids = snap.docs.map((d) => d.id).filter(Boolean);
  if (ids.length === 0) ids.push(tenancy.getTenantId());
  return ids;
}

function watchdogStateDoc(tid) {
  return `${tenancy.tenantDoc(tid)}/settings/watchdog_alerts`;
}

function buildIncidentId(checkKey, eventType, nowMs, cooldownMs) {
  const bucket = Math.floor(nowMs / cooldownMs);
  return `watchdog-${safeKey(checkKey)}-${eventType}-${bucket}`;
}

async function writeIncident(db, tid, checkKey, eventType, message, nowMs, metadata, cooldownMs) {
  const incidentId = buildIncidentId(checkKey, eventType, nowMs, cooldownMs);
  const ref = db.doc(`${tenancy.securityIncidentsPath(tid)}/${incidentId}`);
  const payload = {
    type: eventType === 'recovery' ? 'watchdog_recovery' : 'watchdog_service_down',
    kind: eventType,
    createdAt: toIso(nowMs),
    resolved: eventType === 'recovery',
    severity: 'critical',
    source: 'watchdog_cron',
    service: checkKey,
    gate: checkKey,
    notes: message,
    eventId: incidentId,
    metadata: {
      ...metadata,
      checkKey,
      eventType,
      generatedBy: 'run-watchdog-health',
    },
  };

  try {
    await ref.create(payload);
    return { created: true, incidentId };
  } catch (e) {
    const code = e?.code || e?.status;
    if (code === 6 || /already exists/i.test(String(e?.message || ''))) {
      return { created: false, incidentId };
    }
    throw e;
  }
}

function evaluateTransition(prevState, checkResult, nowMs, cooldownMs) {
  const nowIso = toIso(nowMs);
  const prev = prevState || {};
  const prevStatus = prev.status || 'ok';

  if (checkResult.failed) {
    const prevFailureStartMs = toMs(prev.failureStartedAt);
    const failureStartedMs = prevStatus === 'failed' && prevFailureStartMs ? prevFailureStartMs : nowMs;
    const failureDurationMs = Math.max(0, nowMs - failureStartedMs);
    const graceMs = parseMs(checkResult.graceMs, 0);
    const lastAlertMs = toMs(prev.lastAlertAt);
    const cooldownPassed = !lastAlertMs || (nowMs - lastAlertMs) >= cooldownMs;
    const shouldAlertFailure = failureDurationMs >= graceMs && cooldownPassed;

    return {
      action: shouldAlertFailure ? 'alert_failure' : 'none',
      state: {
        ...prev,
        status: 'failed',
        lastCheckedAt: nowIso,
        failureStartedAt: toIso(failureStartedMs),
        consecutiveFailures: Number(prev.consecutiveFailures || 0) + 1,
        lastError: checkResult.message,
        lastLatencyMs: checkResult.latencyMs ?? null,
        lastDetails: checkResult.details || null,
        alertActive: Boolean(prev.alertActive) || shouldAlertFailure,
        ...(shouldAlertFailure ? { lastAlertAt: nowIso, lastAlertType: 'failure' } : {}),
      },
    };
  }

  const shouldRecovery = prevStatus === 'failed' && Boolean(prev.alertActive);
  return {
    action: shouldRecovery ? 'alert_recovery' : 'none',
    state: {
      ...prev,
      status: 'ok',
      lastCheckedAt: nowIso,
      failureStartedAt: null,
      consecutiveFailures: 0,
      lastError: null,
      lastLatencyMs: checkResult.latencyMs ?? null,
      lastDetails: checkResult.details || null,
      alertActive: false,
      ...(shouldRecovery ? { lastRecoveryAt: nowIso, lastAlertType: 'recovery' } : {}),
    },
  };
}

async function probeApiHealth(req) {
  const timeoutMs = parseMs(process.env.WATCHDOG_PROBE_TIMEOUT_MS, DEFAULT_PROBE_TIMEOUT_MS);
  const baseUrl = resolveBaseUrl(req);
  if (!baseUrl) {
    return { failed: true, message: 'Unable to resolve base URL for /api/health probe', details: { baseUrl: null } };
  }

  const started = Date.now();
  try {
    const resp = await fetchWithTimeout(`${baseUrl}/api/health`, timeoutMs);
    const latencyMs = Date.now() - started;
    if (!resp.ok) {
      return {
        failed: true,
        message: `API health endpoint returned ${resp.status}`,
        latencyMs,
        details: { status: resp.status, baseUrl },
      };
    }

    return { failed: false, message: 'API health probe ok', latencyMs, details: { baseUrl } };
  } catch (e) {
    return {
      failed: true,
      message: `API health probe failed: ${String(e?.message || e)}`,
      latencyMs: Date.now() - started,
      details: { baseUrl },
    };
  }
}

async function probeFirestore(db, tid) {
  const latencyLimitMs = parseMs(process.env.WATCHDOG_LATENCY_MS, DEFAULT_LATENCY_THRESHOLD_MS);
  const started = Date.now();
  try {
    await db.doc(tenancy.tenantDoc(tid)).get();
    const latencyMs = Date.now() - started;
    if (latencyMs > latencyLimitMs) {
      return {
        failed: true,
        message: `Firestore latency high (${latencyMs}ms > ${latencyLimitMs}ms)`,
        latencyMs,
        details: { latencyLimitMs },
      };
    }
    return { failed: false, message: 'Firestore probe ok', latencyMs, details: { latencyLimitMs } };
  } catch (e) {
    return {
      failed: true,
      message: `Firestore probe failed: ${String(e?.message || e)}`,
      latencyMs: Date.now() - started,
      details: { latencyLimitMs },
    };
  }
}

async function probeStorage(storage) {
  const latencyLimitMs = parseMs(process.env.WATCHDOG_LATENCY_MS, DEFAULT_LATENCY_THRESHOLD_MS);
  const started = Date.now();
  try {
    const bucket = storage.bucket();
    await bucket.file('__watchdog__/healthcheck.txt').exists();
    const latencyMs = Date.now() - started;
    if (latencyMs > latencyLimitMs) {
      return {
        failed: true,
        message: `Storage latency high (${latencyMs}ms > ${latencyLimitMs}ms)`,
        latencyMs,
        details: { latencyLimitMs, bucket: bucket.name },
      };
    }
    return { failed: false, message: 'Storage probe ok', latencyMs, details: { latencyLimitMs, bucket: bucket.name } };
  } catch (e) {
    return {
      failed: true,
      message: `Storage probe failed: ${String(e?.message || e)}`,
      latencyMs: Date.now() - started,
      details: { latencyLimitMs },
    };
  }
}

async function probeEmailQueue(db) {
  const failedCountThreshold = parseMs(process.env.WATCHDOG_EMAIL_FAILED_SPIKE_COUNT, 20);
  const failedRateThreshold = Number(process.env.WATCHDOG_EMAIL_FAILED_SPIKE_RATE || 0.5);
  const minTotal = parseMs(process.env.WATCHDOG_EMAIL_FAILED_SPIKE_MIN_TOTAL, 40);
  const cut1h = new Date(Date.now() - 60 * 60 * 1000);

  try {
    const snap = await db.collection('email_queue')
      .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(cut1h))
      .orderBy('createdAt', 'desc')
      .limit(500)
      .get();

    let total = 0;
    let failed = 0;
    let pending = 0;
    let retrying = 0;

    snap.forEach((doc) => {
      total += 1;
      const payload = doc.data() || {};
      const status = String(payload.status || '').toLowerCase();
      // Avoid alert loops: watchdog/security incident alert failures should not
      // trigger more watchdog email queue alerts.
      if (String(payload.source || '').toLowerCase() === 'security_incident_alert') return;
      if (status === 'failed' || status === 'failed_final') failed += 1;
      if (status === 'pending') pending += 1;
      if (status === 'retrying') retrying += 1;
    });

    const failedRate = total > 0 ? failed / total : 0;
    const spike = failed >= failedCountThreshold || (total >= minTotal && failedRate >= failedRateThreshold);

    if (spike) {
      return {
        failed: true,
        message: `Email queue failures spiked (failed=${failed}, total=${total}, rate=${(failedRate * 100).toFixed(1)}%)`,
        details: { failed, total, failedRate, pending, retrying, failedCountThreshold, failedRateThreshold, minTotal },
      };
    }

    return {
      failed: false,
      message: 'Email queue probe ok',
      details: { failed, total, failedRate, pending, retrying, failedCountThreshold, failedRateThreshold, minTotal },
    };
  } catch (e) {
    return {
      failed: true,
      message: `Email queue probe failed: ${String(e?.message || e)}`,
      details: { failedCountThreshold, failedRateThreshold, minTotal },
    };
  }
}

async function probeTerminals(db, tid) {
  const hikUser = process.env.HIKVISION_USER || process.env.HIK_USER || 'admin';
  const hikPass = process.env.HIKVISION_PASS || process.env.HIK_PASS || '';
  const timeoutMs = parseMs(process.env.WATCHDOG_TERMINAL_TIMEOUT_MS, 5000);

  const terminals = [];
  try {
    const snap = await db.collection(tenancy.terminalsPath(tid)).get();
    snap.forEach((doc) => {
      const d = doc.data() || {};
      if (d.ip && isAllowedDeviceIP(d.ip)) {
        terminals.push({ id: doc.id, ip: d.ip, name: d.name || doc.id });
      }
    });
  } catch (e) {
    return [{
      key: 'terminals_registry',
      failed: true,
      message: `Terminal registry read failed: ${String(e?.message || e)}`,
      details: {},
      graceMs: DEFAULT_TERMINAL_GRACE_MS,
    }];
  }

  if (terminals.length === 0) {
    return [{
      key: 'terminals_registry',
      failed: true,
      message: 'No terminals registered for tenant',
      details: { terminalCount: 0 },
      graceMs: DEFAULT_TERMINAL_GRACE_MS,
    }];
  }

  const checks = await Promise.all(terminals.map(async (term) => {
    const started = Date.now();
    try {
      const resp = await hikRequest(
        { ip: term.ip, username: hikUser, password: hikPass },
        'get',
        '/ISAPI/System/deviceInfo',
        null,
        { timeout: timeoutMs },
      );
      const latencyMs = Date.now() - started;
      const ok = resp.status >= 200 && resp.status < 300;
      return {
        key: `terminal_${safeKey(term.id)}`,
        failed: !ok,
        message: ok ? `Terminal ${term.name} healthy` : `Terminal ${term.name} returned ${resp.status}`,
        latencyMs,
        details: { terminalId: term.id, terminalName: term.name, ip: term.ip, status: resp.status },
        graceMs: DEFAULT_TERMINAL_GRACE_MS,
      };
    } catch (e) {
      return {
        key: `terminal_${safeKey(term.id)}`,
        failed: true,
        message: `Terminal ${term.name} down: ${String(e?.message || e)}`,
        latencyMs: Date.now() - started,
        details: { terminalId: term.id, terminalName: term.name, ip: term.ip },
        graceMs: DEFAULT_TERMINAL_GRACE_MS,
      };
    }
  }));

  return checks;
}

async function runTenantChecks(req, db, storage, tid, previousChecks, cooldownMs, nowMs) {
  const incidents = [];
  const checksState = { ...(previousChecks || {}) };
  const policy = alertPolicy();

  const apiProbe = await probeApiHealth(req);
  const firestoreProbe = await probeFirestore(db, tid);
  const storageProbe = await probeStorage(storage);
  const emailQueueProbe = await probeEmailQueue(db);
  const terminalProbes = await probeTerminals(db, tid);

  const terminalChecks = terminalProbes.filter((c) => String(c.key || '').startsWith('terminal_'));
  const nonTerminalChecks = terminalProbes.filter((c) => !String(c.key || '').startsWith('terminal_'));
  const downTerminals = terminalChecks.filter((c) => c.failed);
  const terminalTotal = terminalChecks.length;
  const downCount = downTerminals.length;
  const downRatio = terminalTotal > 0 ? downCount / terminalTotal : 0;
  const fleetFailed = terminalTotal > 0 && (
    (policy.notifySingleTerminal && downCount >= 1)
      || (downCount >= policy.terminalDownMinCount && downRatio >= policy.terminalDownMinRatio)
  );

  const terminalFleetProbe = {
    key: 'terminals_fleet',
    failed: fleetFailed,
    message: fleetFailed
      ? `Terminal fleet degraded (${downCount}/${terminalTotal} down)`
      : `Terminal fleet healthy (${terminalTotal - downCount}/${terminalTotal} up)`,
    details: {
      downCount,
      terminalTotal,
      downRatio,
      downTerminalIds: downTerminals.map((t) => t.details?.terminalId).filter(Boolean),
      downTerminalNames: downTerminals.map((t) => t.details?.terminalName).filter(Boolean),
      policy: {
        notifySingleTerminal: policy.notifySingleTerminal,
        terminalDownMinCount: policy.terminalDownMinCount,
        terminalDownMinRatio: policy.terminalDownMinRatio,
      },
    },
    graceMs: DEFAULT_TERMINAL_GRACE_MS,
  };

  const allChecks = [
    { key: 'api_health', ...apiProbe },
    { key: 'firestore', ...firestoreProbe },
    { key: 'storage', ...storageProbe },
    { key: 'email_queue', ...emailQueueProbe },
    ...nonTerminalChecks,
    terminalFleetProbe,
  ];

  for (const check of allChecks) {
    const prev = checksState[check.key] || {};
    const evaluated = evaluateTransition(prev, check, nowMs, cooldownMs);
    checksState[check.key] = evaluated.state;

    if (evaluated.action === 'alert_failure') {
      const emailAlert = shouldEmailAlert(check.key, 'failure', policy);
      const created = await writeIncident(
        db,
        tid,
        check.key,
        'failure',
        check.message,
        nowMs,
        {
          status: 'down',
          latencyMs: check.latencyMs ?? null,
          details: check.details || null,
          graceMs: parseMs(check.graceMs, 0),
          alertEmail: emailAlert,
        },
        cooldownMs,
      );
      incidents.push({ ...created, type: 'failure', checkKey: check.key, message: check.message });
    }

    if (evaluated.action === 'alert_recovery') {
      const emailAlert = shouldEmailAlert(check.key, 'recovery', policy);
      const created = await writeIncident(
        db,
        tid,
        check.key,
        'recovery',
        `${check.key} recovered`,
        nowMs,
        {
          status: 'up',
          latencyMs: check.latencyMs ?? null,
          details: check.details || null,
          alertEmail: emailAlert,
        },
        cooldownMs,
      );
      incidents.push({ ...created, type: 'recovery', checkKey: check.key, message: `${check.key} recovered` });
    }
  }

  const failing = allChecks.filter((c) => c.failed).map((c) => ({ key: c.key, message: c.message }));

  return { checksState, incidents, failing, totalChecks: allChecks.length };
}

async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'method' });
  }
  if (!authorize(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!WATCHDOG_ENABLED) {
    return res.status(200).json({ ok: true, disabled: true, message: 'Watchdog disabled pending tomorrow restart' });
  }

  initializeFirebase();
  const db = admin.firestore();
  const storage = admin.storage();
  const nowMs = Date.now();
  const cooldownMs = parseMs(process.env.WATCHDOG_ALERT_COOLDOWN_MS, DEFAULT_COOLDOWN_MS);

  const summary = {
    ok: true,
    checkedAt: toIso(nowMs),
    cooldownMs,
    tenants: 0,
    processed: 0,
    incidentsCreated: 0,
    failures: 0,
    errors: [],
    byTenant: {},
  };

  try {
    const tenantIds = await listTenantIds(db);
    summary.tenants = tenantIds.length;

    for (const tid of tenantIds) {
      try {
        const stateRef = db.doc(watchdogStateDoc(tid));
        const snap = await stateRef.get();
        const current = snap.exists ? (snap.data() || {}) : {};

        const result = await runTenantChecks(
          req,
          db,
          storage,
          tid,
          current.checks || {},
          cooldownMs,
          nowMs,
        );

        const failures = result.failing.length;
        summary.failures += failures;
        summary.incidentsCreated += result.incidents.filter((i) => i.created).length;
        summary.processed += 1;
        summary.byTenant[tid] = {
          failures,
          totalChecks: result.totalChecks,
          failing: result.failing,
          incidents: result.incidents,
        };

        await stateRef.set({
          updatedAt: toIso(nowMs),
          cooldownMs,
          checks: result.checksState,
        }, { merge: true });
      } catch (e) {
        summary.errors.push({ tenantId: tid, error: String(e?.message || e) });
      }
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'watchdog_failed', message: String(e?.message || e), summary });
  }

  return res.status(200).json(summary);
}

export default handler;
