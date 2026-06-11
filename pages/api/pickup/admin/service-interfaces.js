/**
 * GET /api/pickup/admin/service-interfaces
 *
 * Probes every external service the PickupGuard system connects to and returns
 * Cisco-style interface counters. Results are used to render the
 * /v2/system-interfaces "show interfaces" page.
 *
 * Services probed:
 *   - Firebase/Firestore  (latency probe + 24h packet counters)
 *   - Resend/Email        (key format check + email_queue counters)
 *   - Hikvision terminals (live ISAPI /deviceInfo probe per registered terminal)
 *   - WhatsApp            (webhook URL presence check — no live probe)
 *   - BINUS School API    (env key presence check — no live probe)
 *   - Cloud Functions     (static note — no live probe)
 *
 * All probes run concurrently via Promise.allSettled.
 * API keys are MASKED server-side — raw values never leave the server.
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import { withApi } from '../../../../lib/api-auth';
import { hikRequest, isAllowedDeviceIP } from '../../../../lib/hikvision';
const tenancy = require('../../../../lib/tenancy');

// ─── Key masking ──────────────────────────────────────────────────────────────
function maskKey(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s.length <= 8) return '****';
  if (s.length <= 12) return s.slice(0, 2) + '****' + s.slice(-2);
  return s.slice(0, 4) + '****...****' + s.slice(-4);
}
// Passwords always fully obscured — no characters shown
function maskPass(raw) {
  if (!raw) return null;
  return '••••••••';
}

// ─── Cisco metric helpers ─────────────────────────────────────────────────────
function reliabilityStr(status) {
  if (status === 'up')          return '255/255';
  if (status === 'degraded')    return '128/255';
  if (status === 'unconfigured') return '255/255'; // key present, just not probed
  return '0/255';
}
function loadVal(ratePerMin, saturation = 100) {
  const v = Math.round(Math.min((ratePerMin / saturation) * 255, 255));
  return `${v}/255`;
}
function fmtBytes(n) {
  if (n < 1024) return `${n}`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1048576).toFixed(1)}M`;
}
function fmtLastSeen(ms) {
  if (ms == null) return 'never';
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
function tsMs(v) {
  if (!v) return null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.toDate === 'function') return v.toDate().getTime();
  if (typeof v === 'string') return Date.parse(v);
  return null;
}

// ─── Main handler ─────────────────────────────────────────────────────────────
async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });

  initializeFirebase();
  const db = admin.firestore();
  const tid = tenancy.getTenantId(req.query.tenant);
  const now = Date.now();
  const cut24h = new Date(now - 24 * 3600 * 1000);
  const cut5m  = now - 5 * 60 * 1000;
  const cut1h  = now - 3600 * 1000;

  // ── Probe 1: Firebase / Firestore ─────────────────────────────────────────
  const firestoreProbe = (async () => {
    const t0 = Date.now();
    try {
      await db.doc(tenancy.tenantDoc(tid)).get();
      return { ok: true, latencyMs: Date.now() - t0 };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, error: e.message };
    }
  })();

  // ── Probe 2: email_queue counters ─────────────────────────────────────────
  const emailQueueProbe = (async () => {
    try {
      const snap = await db.collection('email_queue')
        .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(cut24h))
        .orderBy('createdAt', 'desc')
        .limit(500)
        .get();
      let pending = 0, sent = 0, failed = 0, retrying = 0, resets = 0;
      let sent5m = 0, sent1h = 0;
      snap.forEach((doc) => {
        const d = doc.data();
        const s = d.status || 'unknown';
        if (s === 'pending')  pending++;
        if (s === 'sent')     { sent++; const createdMs = tsMs(d.createdAt); if (createdMs && createdMs >= cut5m) sent5m++; if (createdMs && createdMs >= cut1h) sent1h++; }
        if (s === 'failed')   { failed++; resets += (d.retryCount || 0); }
        if (s === 'retrying') retrying++;
      });
      return { ok: true, pending, sent, failed, retrying, resets, sent5m, sent1h };
    } catch (e) {
      return { ok: false, pending: 0, sent: 0, failed: 0, retrying: 0, resets: 0, sent5m: 0, sent1h: 0, error: e.message };
    }
  })();

  // ── Probe 3: pickup_events counters for Firebase interface ────────────────
  const pickupEventsProbe = (async () => {
    try {
      const snap = await db.collection(tenancy.pickupEventsPath(tid))
        .where('recordedAt', '>=', admin.firestore.Timestamp.fromDate(cut24h))
        .orderBy('recordedAt', 'desc')
        .limit(3000)
        .get();
      let total24h = 0, total5m = 0, total1h = 0;
      snap.forEach((doc) => {
        const ms = tsMs(doc.data().recordedAt);
        total24h++;
        if (ms && ms >= cut5m) total5m++;
        if (ms && ms >= cut1h) total1h++;
      });
      return { ok: true, total24h, total5m, total1h };
    } catch (e) {
      return { ok: false, total24h: 0, total5m: 0, total1h: 0, error: e.message };
    }
  })();

  // ── Probe 4: WhatsApp webhook config ──────────────────────────────────────
  const whatsappProbe = (async () => {
    try {
      const snap = await db.doc(tenancy.pickupIntegrationsDoc(tid)).get();
      const waUrl = snap.exists ? (snap.data()?.whatsappBroadcastUrl || '') : '';
      return { ok: true, configured: !!waUrl };
    } catch (e) {
      return { ok: false, configured: false, error: e.message };
    }
  })();

  // ── Probe 5: Hikvision terminals ──────────────────────────────────────────
  const terminalsProbe = (async () => {
    const hikUser = process.env.HIKVISION_USER || process.env.HIK_USER || 'admin';
    const hikPass = process.env.HIKVISION_PASS || process.env.HIK_PASS || '';

    let terminals = [];
    try {
      const snap = await db.collection(tenancy.terminalsPath(tid)).get();
      snap.forEach((doc) => {
        const d = doc.data();
        if (d.ip && isAllowedDeviceIP(d.ip)) {
          terminals.push({ id: doc.id, name: d.name || doc.id, ip: d.ip, hardware: d.hardware || d.deviceName || 'DS-K1T3xx', gradeLabel: d.gradeLabel || null });
        }
      });
    } catch { /* terminals collection may not exist */ }

    const results = await Promise.allSettled(
      terminals.map(async (term) => {
        const t0 = Date.now();
        try {
          const resp = await hikRequest(
            { ip: term.ip, username: hikUser, password: hikPass },
            'get',
            '/ISAPI/System/deviceInfo',
            null,
            { timeout: 5000 },
          );
          const latencyMs = Date.now() - t0;
          const isUp = resp.status >= 200 && resp.status < 300;
          return { ...term, status: isUp ? 'up' : 'degraded', latencyMs, probeError: null };
        } catch (e) {
          return { ...term, status: 'down', latencyMs: Date.now() - t0, probeError: e.message };
        }
      })
    );

    return results.map((r, i) =>
      r.status === 'fulfilled' ? r.value : { ...terminals[i], status: 'down', latencyMs: null, probeError: r.reason?.message }
    );
  })();

  // ── Wait for all probes ───────────────────────────────────────────────────
  const [fsProbe, emailQ, pickupEv, waProbe, termResults] = await Promise.all([
    firestoreProbe, emailQueueProbe, pickupEventsProbe, whatsappProbe, terminalsProbe,
  ]);

  // ── Build interface records ───────────────────────────────────────────────
  const interfaces = [];
  let ifIdx = 0;

  // Firebase / Firestore
  {
    const status = fsProbe.ok ? 'up' : 'down';
    const latMs  = fsProbe.latencyMs || 0;
    const inputPkts  = pickupEv.total24h;
    const outputPkts = emailQ.sent;
    const inputRate5m  = parseFloat((pickupEv.total5m / 300).toFixed(4)); // pkts/sec
    const outputRate5m = parseFloat((emailQ.sent5m / 300).toFixed(4));
    const inputBits5m  = Math.round(inputRate5m * 2048 * 8);
    const outputBits5m = Math.round(outputRate5m * 51200 * 8);
    interfaces.push({
      id: 'firebase',
      ifName: `GigabitEthernet0/${ifIdx++}`,
      name: 'Firebase / Firestore',
      hardware: 'Google Cloud Firestore SDK v9',
      description: `Primary database — ${process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || 'facial-attendance-binus'}`,
      address: 'firestore.googleapis.com',
      status,
      encapsulation: 'ARPA',
      bwKbps: 1000000,
      delayUsec: latMs * 1000,
      mtu: 1500,
      reliabilityStr: reliabilityStr(status),
      txload: loadVal(outputRate5m * 60, 100),
      rxload: loadVal(inputRate5m * 60, 500),
      counters: {
        inputPackets: inputPkts,
        outputPackets: outputPkts,
        inputRate5min: inputRate5m,
        outputRate5min: outputRate5m,
        inputBitsRate5min: inputBits5m,
        outputBitsRate5min: outputBits5m,
        inputErrors: 0,
        outputErrors: emailQ.failed,
        crcErrors: 0, runts: 0, giants: 0,
        frameErrors: 0, overruns: 0, collisions: 0,
        interfaceResets: 0,
        outputDrops: 0,
        inputBytes: inputPkts * 2048,
        outputBytes: outputPkts * 51200,
      },
      probe: { latencyMs: fsProbe.latencyMs, checkedAt: new Date().toISOString(), error: fsProbe.error || null },
    });
  }

  // Resend / Email
  {
    const resendKey = process.env.RESEND_API_KEY || '';
    const keyValid  = resendKey.startsWith('re_') && resendKey.length > 10;
    const status    = !resendKey ? 'unconfigured' : keyValid ? 'up' : 'degraded';
    const outputRate5m = parseFloat((emailQ.sent5m / 300).toFixed(4));
    const outputBits5m = Math.round(outputRate5m * 51200 * 8);
    interfaces.push({
      id: 'resend',
      ifName: `GigabitEthernet0/${ifIdx++}`,
      name: 'Resend / Transactional Email',
      hardware: 'Resend SMTP/API relay',
      description: 'Pickup notification emails — transactional delivery',
      address: 'api.resend.com',
      status,
      encapsulation: 'ARPA',
      bwKbps: 100000,
      delayUsec: 150000,
      mtu: 1500,
      reliabilityStr: reliabilityStr(status),
      txload: loadVal(outputRate5m * 60, 50),
      rxload: '1/255',
      counters: {
        inputPackets: emailQ.pending,
        outputPackets: emailQ.sent,
        inputRate5min: 0,
        outputRate5min: outputRate5m,
        inputBitsRate5min: 0,
        outputBitsRate5min: outputBits5m,
        inputErrors: emailQ.retrying,
        outputErrors: emailQ.failed,
        crcErrors: 0, runts: 0, giants: 0,
        frameErrors: 0, overruns: 0, collisions: 0,
        interfaceResets: emailQ.resets,
        outputDrops: emailQ.failed,
        inputBytes: emailQ.pending * 512,
        outputBytes: emailQ.sent * 51200,
      },
      probe: { latencyMs: null, checkedAt: new Date().toISOString(), error: emailQ.error || null },
    });
  }

  // Hikvision terminals — one interface per registered terminal
  for (const term of termResults) {
    const status = term.status;
    interfaces.push({
      id: `hik_${term.id}`,
      ifName: `Serial0/${ifIdx++}`,
      name: `Hikvision — ${term.name}`,
      hardware: term.hardware || 'DS-K1T341AMF',
      description: `Face terminal${term.gradeLabel ? ` — Grade ${term.gradeLabel}` : ''} — ISAPI/Digest`,
      address: term.ip,
      status,
      encapsulation: 'HDLC',
      bwKbps: 100000,
      delayUsec: term.latencyMs != null ? term.latencyMs * 1000 : 20000,
      mtu: 1500,
      reliabilityStr: reliabilityStr(status),
      txload: '1/255',
      rxload: '1/255',
      counters: {
        inputPackets: 0, outputPackets: 0,
        inputRate5min: 0, outputRate5min: 0,
        inputBitsRate5min: 0, outputBitsRate5min: 0,
        inputErrors: term.status === 'down' ? 1 : 0,
        outputErrors: 0, crcErrors: 0, runts: 0, giants: 0,
        frameErrors: 0, overruns: 0, collisions: 0,
        interfaceResets: 0, outputDrops: 0,
        inputBytes: 0, outputBytes: 0,
      },
      probe: { latencyMs: term.latencyMs, checkedAt: new Date().toISOString(), error: term.probeError || null },
    });
  }

  // If no terminals registered, add a placeholder
  if (termResults.length === 0) {
    interfaces.push({
      id: 'hik_placeholder',
      ifName: `Serial0/${ifIdx++}`,
      name: 'Hikvision — (no terminals registered)',
      hardware: 'DS-K1T341AMF',
      description: 'Register terminals at /v2/terminals to enable probing',
      address: null,
      status: 'unconfigured',
      encapsulation: 'HDLC',
      bwKbps: 100000, delayUsec: 0, mtu: 1500,
      reliabilityStr: '255/255', txload: '0/255', rxload: '0/255',
      counters: { inputPackets: 0, outputPackets: 0, inputRate5min: 0, outputRate5min: 0, inputBitsRate5min: 0, outputBitsRate5min: 0, inputErrors: 0, outputErrors: 0, crcErrors: 0, runts: 0, giants: 0, frameErrors: 0, overruns: 0, collisions: 0, interfaceResets: 0, outputDrops: 0, inputBytes: 0, outputBytes: 0 },
      probe: { latencyMs: null, checkedAt: new Date().toISOString(), error: null },
    });
  }

  // WhatsApp webhook
  {
    const status = waProbe.configured ? 'unconfigured' : 'unconfigured';
    const actualStatus = waProbe.configured ? 'up' : 'unconfigured';
    interfaces.push({
      id: 'whatsapp',
      ifName: `Tunnel0/${ifIdx++}`,
      name: 'WhatsApp Broadcast',
      hardware: 'WhatsApp Business API webhook',
      description: 'Pickup notification broadcast — outbound only',
      address: waProbe.configured ? 'webhook endpoint' : null,
      status: actualStatus,
      encapsulation: 'GRE',
      bwKbps: 10000,
      delayUsec: 250000,
      mtu: 1500,
      reliabilityStr: reliabilityStr(actualStatus),
      txload: '0/255',
      rxload: '0/255',
      counters: { inputPackets: 0, outputPackets: 0, inputRate5min: 0, outputRate5min: 0, inputBitsRate5min: 0, outputBitsRate5min: 0, inputErrors: 0, outputErrors: 0, crcErrors: 0, runts: 0, giants: 0, frameErrors: 0, overruns: 0, collisions: 0, interfaceResets: 0, outputDrops: 0, inputBytes: 0, outputBytes: 0 },
      probe: { latencyMs: null, checkedAt: new Date().toISOString(), error: waProbe.error || null },
    });
  }

  // BINUS School API
  {
    const apiKey = process.env.API_KEY || process.env.BINUS_API_KEY || '';
    const status = apiKey ? 'unconfigured' : 'unconfigured';
    const actualStatus = apiKey ? 'up' : 'unconfigured';
    interfaces.push({
      id: 'binus_api',
      ifName: `Tunnel0/${ifIdx++}`,
      name: 'BINUS School API',
      hardware: 'BINUS School REST API (UAT)',
      description: 'Student metadata — attendance submission endpoint',
      address: 'api.binus.ac.id',
      status: actualStatus,
      encapsulation: 'GRE',
      bwKbps: 100000,
      delayUsec: 100000,
      mtu: 1500,
      reliabilityStr: reliabilityStr(actualStatus),
      txload: '0/255',
      rxload: '0/255',
      counters: { inputPackets: 0, outputPackets: 0, inputRate5min: 0, outputRate5min: 0, inputBitsRate5min: 0, outputBitsRate5min: 0, inputErrors: 0, outputErrors: 0, crcErrors: 0, runts: 0, giants: 0, frameErrors: 0, overruns: 0, collisions: 0, interfaceResets: 0, outputDrops: 0, inputBytes: 0, outputBytes: 0 },
      probe: { latencyMs: null, checkedAt: new Date().toISOString(), error: null },
    });
  }

  // Cloud Functions
  {
    interfaces.push({
      id: 'cloud_functions',
      ifName: `Loopback0`,
      name: 'Firebase Cloud Functions',
      hardware: 'Node.js 20 runtime — us-central1',
      description: 'processEmailQueue — triggered on email_queue writes',
      address: 'cloudfunctions.googleapis.com',
      status: 'up',
      encapsulation: 'ARPA',
      bwKbps: 1000000,
      delayUsec: 500000,
      mtu: 65535,
      reliabilityStr: '255/255',
      txload: loadVal(emailQ.sent1h / 60, 50),
      rxload: '1/255',
      counters: {
        inputPackets: emailQ.sent + emailQ.failed,
        outputPackets: emailQ.sent,
        inputRate5min: 0, outputRate5min: 0, inputBitsRate5min: 0, outputBitsRate5min: 0,
        inputErrors: emailQ.failed, outputErrors: 0, crcErrors: 0, runts: 0, giants: 0,
        frameErrors: 0, overruns: 0, collisions: 0,
        interfaceResets: emailQ.resets,
        outputDrops: 0,
        inputBytes: 0, outputBytes: 0,
      },
      probe: { latencyMs: null, checkedAt: new Date().toISOString(), error: null, note: 'No live probe — check Firebase console for invocation errors' },
    });
  }

  // ── API key status summary (server-side masked) ───────────────────────────
  const hikUser = process.env.HIKVISION_USER || process.env.HIK_USER || '';
  const hikPass = process.env.HIKVISION_PASS || process.env.HIK_PASS || '';
  const resendKey = process.env.RESEND_API_KEY || '';
  const binusKey  = process.env.API_KEY || process.env.BINUS_API_KEY || '';
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || null;

  const keys = {
    RESEND_API_KEY:   { present: !!resendKey,  masked: maskKey(resendKey),  status: resendKey ? 'ok' : 'missing' },
    API_KEY:          { present: !!binusKey,   masked: maskKey(binusKey),   status: binusKey  ? 'ok' : 'missing' },
    HIKVISION_USER:   { present: !!hikUser,    masked: maskKey(hikUser),    status: hikUser   ? 'ok' : 'missing' },
    HIKVISION_PASS:   { present: !!hikPass,    masked: maskPass(hikPass),   status: hikPass   ? 'ok' : 'missing' },
    WHATSAPP_WEBHOOK: { present: waProbe.configured, masked: null,          status: waProbe.configured ? 'configured' : 'missing' },
    FIREBASE:         { present: !!projectId,  masked: projectId,           status: projectId ? 'ok' : 'missing' },
  };

  const upCount = interfaces.filter((i) => i.status === 'up').length;
  const totalCount = interfaces.length;
  const hikReachable = termResults.filter((t) => t.status === 'up').length;
  const keyConfigured = Object.values(keys).filter((k) => k.status === 'ok' || k.status === 'configured').length;

  return res.status(200).json({
    ok: true,
    generatedAt: new Date().toISOString(),
    summary: {
      upCount,
      totalCount,
      hikReachable,
      hikTotal: termResults.length,
      keyConfigured,
      keyTotal: Object.keys(keys).length,
      fsLatencyMs: fsProbe.latencyMs,
    },
    interfaces,
    keys,
  });
}

export default withApi(handler, { methods: ['GET'], permission: 'analytics.view' });
