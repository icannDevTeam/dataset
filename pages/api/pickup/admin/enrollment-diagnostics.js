import admin from 'firebase-admin';
import { withApi } from '../../../../lib/api-auth';
import { initializeFirebase } from '../../../../lib/firebase-admin';

const tenancy = require('../../../../lib/tenancy');

function normalizeScopeToken(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return [];
  if (raw === 'EY') return ['EY'];
  if (/^EY[1-3]$/.test(raw)) return [raw];
  const m = raw.match(/^(\d{1,2})/);
  if (m) return [m[1]];
  return [raw];
}

function deriveChaperoneScopes(ch) {
  const out = new Set();
  const add = (v) => {
    const raw = String(v || '').trim().toUpperCase();
    if (!raw) return;
    if (/^EY\d+$/.test(raw)) {
      out.add(raw);
      out.add('EY');
      return;
    }
    normalizeScopeToken(v).forEach((x) => out.add(x));
  };
  (ch?.studentGrades || []).forEach(add);
  (ch?.studentClasses || []).forEach(add);
  return [...out];
}

function tsToMs(v) {
  if (!v) return 0;
  if (typeof v === 'string') return Date.parse(v) || 0;
  if (typeof v?.toDate === 'function') return v.toDate().getTime();
  if (v._seconds) return Number(v._seconds) * 1000;
  return 0;
}

function severityOf(type) {
  if (['missing_face', 'device_errors', 'broken_override'].includes(type)) return 'high';
  if (['not_enrolled', 'no_terminal_match', 'stale_lock'].includes(type)) return 'medium';
  return 'low';
}

function pushIssue(items, issue) {
  items.push({ ...issue, severity: severityOf(issue.type) });
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  const tid = tenancy.getTenantId(req.query.tenant);

  try {
    initializeFirebase();
    const db = admin.firestore();

    const [terminalSnap, chaperoneSnap, lockSnap] = await Promise.all([
      db.collection(tenancy.terminalsPath(tid)).get(),
      db.collection(tenancy.chaperonesPath(tid)).limit(100).get(),
      db.collection(tenancy.pickupStudentLocksPath(tid)).where('status', '==', 'pending').limit(100).get(),
    ]);

    const terminals = [];
    terminalSnap.forEach((d) => {
      const t = d.data() || {};
      terminals.push({
        id: d.id,
        name: t.name || t.deviceName || t.ip || d.id,
        gradeScopes: Array.isArray(t.gradeScopes) ? t.gradeScopes.map((x) => String(x).trim()).filter(Boolean) : [],
      });
    });
    const terminalIdSet = new Set(terminals.map((t) => t.id));

    const items = [];

    chaperoneSnap.forEach((d) => {
      const c = d.data() || {};
      if ((c.lifecycleStatus || 'active') === 'deleted') return;

      const chaperoneBase = {
        chaperoneId: d.id,
        chaperoneName: c.name || d.id,
        employeeNo: c.employeeNo || null,
        status: c.status || null,
      };

      const facePaths = Array.isArray(c.facePaths) ? c.facePaths.filter(Boolean) : [];
      const hasFace = facePaths.length > 0;
      const enrollErrors = Array.isArray(c.deviceEnrollErrors) ? c.deviceEnrollErrors.filter(Boolean) : [];
      const deviceEnrolled = c.deviceEnrolled === true;

      if (!hasFace) {
        pushIssue(items, {
          ...chaperoneBase,
          type: 'missing_face',
          message: 'No face photo on chaperone record. Upload photo before enroll.',
        });
      }

      if (enrollErrors.length > 0) {
        pushIssue(items, {
          ...chaperoneBase,
          type: 'device_errors',
          message: enrollErrors[0],
          details: enrollErrors.slice(0, 3),
        });
      }

      if (!deviceEnrolled && hasFace && (c.status === 'approved' || c.status === 'approved_pending_faces')) {
        pushIssue(items, {
          ...chaperoneBase,
          type: 'not_enrolled',
          message: 'Approved chaperone is not successfully enrolled on terminals.',
        });
      }

      const assignmentMode = c.assignmentMode === 'override' ? 'override' : 'derived';
      const allowedTerminalIds = Array.isArray(c.allowedTerminalIds) ? [...new Set(c.allowedTerminalIds.map((x) => String(x).trim()).filter(Boolean))] : [];
      if (assignmentMode === 'override') {
        const missing = allowedTerminalIds.filter((id) => !terminalIdSet.has(id));
        if (missing.length > 0 || allowedTerminalIds.length === 0) {
          pushIssue(items, {
            ...chaperoneBase,
            type: 'broken_override',
            message: missing.length > 0
              ? `Override points to missing terminals: ${missing.join(', ')}`
              : 'Override mode enabled but allowedTerminalIds is empty.',
            details: { allowedTerminalIds, missing },
          });
        }
      }

      if (assignmentMode === 'derived') {
        const scopes = deriveChaperoneScopes(c);
        const matched = terminals.filter((t) => {
          if (!t.gradeScopes.length) return true;
          if (!scopes.length) return true;
          const want = new Set(scopes);
          return t.gradeScopes.some((g) => normalizeScopeToken(g).some((tok) => want.has(tok)));
        });
        if (matched.length === 0) {
          pushIssue(items, {
            ...chaperoneBase,
            type: 'no_terminal_match',
            message: 'No active terminal matches this chaperone grade/class scope.',
            details: { studentClasses: c.studentClasses || [], studentGrades: c.studentGrades || [] },
          });
        }
      }
    });

    const now = Date.now();
    lockSnap.forEach((d) => {
      const lock = d.data() || {};
      const submittedAtMs = tsToMs(lock.submittedAt);
      const ageHours = submittedAtMs > 0 ? ((now - submittedAtMs) / 3600000) : null;
      if (ageHours != null && ageHours >= 24) {
        pushIssue(items, {
          type: 'stale_lock',
          chaperoneId: null,
          chaperoneName: lock.guardianName || 'Unknown guardian',
          employeeNo: null,
          status: lock.status || 'pending',
          message: `Student lock pending for ${Math.floor(ageHours)}h (${d.id}).`,
          details: {
            studentId: lock.studentId || d.id,
            recordId: lock.recordId || null,
            formNumber: lock.formNumber || null,
          },
        });
      }
    });

    const summary = {
      total: items.length,
      high: items.filter((x) => x.severity === 'high').length,
      medium: items.filter((x) => x.severity === 'medium').length,
      low: items.filter((x) => x.severity === 'low').length,
      byType: items.reduce((acc, x) => {
        acc[x.type] = (acc[x.type] || 0) + 1;
        return acc;
      }, {}),
    };

    items.sort((a, b) => {
      const rank = (s) => (s === 'high' ? 1 : s === 'medium' ? 2 : 3);
      const r = rank(a.severity) - rank(b.severity);
      if (r !== 0) return r;
      return String(a.chaperoneName || '').localeCompare(String(b.chaperoneName || ''));
    });

    return res.status(200).json({
      ok: true,
      tenantId: tid,
      generatedAt: new Date().toISOString(),
      summary,
      items,
    });
  } catch (err) {
    console.error('[pickup/admin/enrollment-diagnostics]', err.message, err.stack);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}

export default withApi(handler, {
  methods: ['GET'],
  permission: 'pickup_admin.view',
  rateLimit: 120,
});
