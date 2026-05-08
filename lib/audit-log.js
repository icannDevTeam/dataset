/**
 * Audit-log helper — records mutations performed via the dashboard.
 *
 * Stored at: tenants/{tid}/audit_log/{auto-id}
 *
 * Schema:
 *   {
 *     at:        ISO timestamp,
 *     actor:     { email, name, role },
 *     ip:        request ip (best-effort),
 *     userAgent: short ua,
 *     kind:      'settings.update' | 'user.invite' | 'user.delete'
 *              | 'user.suspend'   | 'user.unsuspend' | 'user.role_change'
 *              | 'user.permissions' | 'user.revoke' | 'user.reset_password'
 *              | 'device.pair'    | 'device.unpair' | 'device.revoke'
 *              | 'pickup.officer_override'
 *              | 'pickup.manual_release'
 *              | 'chaperone.enroll' | 'chaperone.reenroll',
 *     target:    { type, id, label } | null,
 *     before:    {} | null,
 *     after:     {} | null,
 *     summary:   short human description,
 *     metadata:  any { ... } | null,
 *   }
 *
 * Failures are swallowed — auditing must never break a request.
 */
const tenancy = require('./tenancy');

function auditLogPath(tid) {
  return `${tenancy.tenantDoc(tid)}/audit_log`;
}

function readClientIp(req) {
  if (!req) return null;
  return (
    (req.headers?.['x-forwarded-for'] || '').toString().split(',')[0].trim()
    || req.headers?.['x-real-ip']
    || req.socket?.remoteAddress
    || null
  );
}

function shortUA(req) {
  const ua = req?.headers?.['user-agent'] || '';
  return typeof ua === 'string' ? ua.slice(0, 200) : null;
}

/**
 * Persist an audit entry.
 *
 * @param {FirebaseFirestore.Firestore} db   admin Firestore instance
 * @param {Object}   opts
 * @param {string}   opts.tenantId
 * @param {Object}   opts.actor       { email, name, role }
 * @param {string}   opts.kind
 * @param {Object?}  opts.target
 * @param {Object?}  opts.before
 * @param {Object?}  opts.after
 * @param {string?}  opts.summary
 * @param {Object?}  opts.metadata
 * @param {Object?}  opts.req         Next.js request (used for ip + UA)
 */
async function logAudit(db, opts = {}) {
  try {
    if (!db) return null;
    const {
      tenantId, actor, kind,
      target = null, before = null, after = null,
      summary = null, metadata = null, req = null,
    } = opts;
    if (!kind) return null;

    const entry = {
      at: new Date().toISOString(),
      actor: actor || { email: null, name: null, role: null },
      ip: readClientIp(req),
      userAgent: shortUA(req),
      kind,
      target,
      before,
      after,
      summary: summary || kind,
      metadata,
    };
    const ref = await db.collection(auditLogPath(tenantId)).add(entry);
    return ref.id;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[audit-log] failed to record entry:', err.message);
    return null;
  }
}

module.exports = { logAudit, auditLogPath };
