/**
 * lib/validation.js — Tiny request-body validators.
 *
 * Designed for hot-path API routes: zero deps, fast, predictable.
 *
 * Usage:
 *   const v = validate(req.body, {
 *     email: { type: 'email', required: true },
 *     name:  { type: 'string', required: true, min: 1, max: 120 },
 *     age:   { type: 'int', min: 0, max: 130 },
 *   });
 *   if (!v.ok) return res.status(400).json({ error: 'invalid_input', details: v.errors });
 *   const { email, name, age } = v.data;
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Conservative ID pattern: alphanumerics + a few separators, length-capped.
const ID_RE = /^[A-Za-z0-9._\-:]{1,128}$/;
const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEX_RE = /^[A-Fa-f0-9]+$/;

function _isPlainString(v) { return typeof v === 'string'; }

function _validateField(name, raw, spec) {
  const errors = [];
  let value = raw;

  if (raw === undefined || raw === null || raw === '') {
    if (spec.required) errors.push(`${name}: required`);
    if (spec.default !== undefined) value = spec.default;
    return { errors, value: errors.length || raw === undefined || raw === null || raw === '' ? value : raw };
  }

  switch (spec.type) {
    case 'string': {
      if (!_isPlainString(raw)) { errors.push(`${name}: must be string`); break; }
      const s = spec.trim === false ? raw : raw.trim();
      if (spec.min != null && s.length < spec.min) errors.push(`${name}: min ${spec.min} chars`);
      if (spec.max != null && s.length > spec.max) errors.push(`${name}: max ${spec.max} chars`);
      if (spec.pattern && !spec.pattern.test(s)) errors.push(`${name}: invalid format`);
      if (spec.enum && !spec.enum.includes(s)) errors.push(`${name}: must be one of ${spec.enum.join(',')}`);
      value = s;
      break;
    }
    case 'email': {
      if (!_isPlainString(raw)) { errors.push(`${name}: must be string`); break; }
      const s = raw.trim().toLowerCase();
      if (s.length > 254) { errors.push(`${name}: too long`); break; }
      if (!EMAIL_RE.test(s)) { errors.push(`${name}: invalid email`); break; }
      value = s;
      break;
    }
    case 'id': {
      if (!_isPlainString(raw)) { errors.push(`${name}: must be string`); break; }
      const s = raw.trim();
      if (!ID_RE.test(s)) { errors.push(`${name}: invalid id`); break; }
      if (spec.max != null && s.length > spec.max) errors.push(`${name}: max ${spec.max} chars`);
      value = s;
      break;
    }
    case 'slug': {
      if (!_isPlainString(raw)) { errors.push(`${name}: must be string`); break; }
      const s = raw.trim();
      if (!SLUG_RE.test(s)) { errors.push(`${name}: invalid slug`); break; }
      value = s;
      break;
    }
    case 'isoDate': {
      if (!_isPlainString(raw) || !ISO_DATE_RE.test(raw)) { errors.push(`${name}: must be YYYY-MM-DD`); break; }
      const d = new Date(raw + 'T00:00:00Z');
      if (Number.isNaN(d.getTime())) { errors.push(`${name}: invalid date`); break; }
      value = raw;
      break;
    }
    case 'int': {
      const n = typeof raw === 'number' ? raw : parseInt(raw, 10);
      if (!Number.isFinite(n) || !Number.isInteger(n)) { errors.push(`${name}: must be integer`); break; }
      if (spec.min != null && n < spec.min) errors.push(`${name}: min ${spec.min}`);
      if (spec.max != null && n > spec.max) errors.push(`${name}: max ${spec.max}`);
      value = n;
      break;
    }
    case 'bool': {
      if (typeof raw === 'boolean') { value = raw; break; }
      if (raw === 'true' || raw === 1 || raw === '1') { value = true; break; }
      if (raw === 'false' || raw === 0 || raw === '0') { value = false; break; }
      errors.push(`${name}: must be boolean`);
      break;
    }
    case 'array': {
      if (!Array.isArray(raw)) { errors.push(`${name}: must be array`); break; }
      if (spec.max != null && raw.length > spec.max) errors.push(`${name}: max ${spec.max} items`);
      if (spec.min != null && raw.length < spec.min) errors.push(`${name}: min ${spec.min} items`);
      value = raw;
      break;
    }
    case 'base64': {
      // Used for inline image payloads — just sanity-cap the size.
      if (!_isPlainString(raw)) { errors.push(`${name}: must be string`); break; }
      const s = raw.startsWith('data:') ? raw.split(',', 2)[1] || '' : raw;
      if (spec.max != null && s.length > spec.max) errors.push(`${name}: payload too large`);
      value = raw;
      break;
    }
    case 'hex': {
      if (!_isPlainString(raw) || !HEX_RE.test(raw)) { errors.push(`${name}: must be hex`); break; }
      if (spec.length != null && raw.length !== spec.length) errors.push(`${name}: must be ${spec.length} chars`);
      value = raw;
      break;
    }
    default:
      errors.push(`${name}: unknown type ${spec.type}`);
  }

  return { errors, value };
}

function validate(body, schema) {
  const data = {};
  const errors = [];
  if (!body || typeof body !== 'object') {
    return { ok: false, errors: ['body: must be a JSON object'], data };
  }
  for (const [name, spec] of Object.entries(schema)) {
    const { errors: errs, value } = _validateField(name, body[name], spec);
    if (errs.length) errors.push(...errs);
    if (value !== undefined) data[name] = value;
  }
  return { ok: errors.length === 0, errors, data };
}

module.exports = { validate, EMAIL_RE, ID_RE, SLUG_RE, ISO_DATE_RE };
