const { GoogleAuth } = require('google-auth-library');

const GCP_MONITORING_BASE = 'https://monitoring.googleapis.com/v3';

// Token cache — GCP tokens last 60min, we refresh at 55min
let _tokenCache = null;
let _tokenExpiry = 0;

function getServiceAccountCredentials() {
  // Prefer JSON string in env (Vercel serverless)
  const jsonStr = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (jsonStr) {
    try {
      return JSON.parse(jsonStr);
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON');
    }
  }
  // Fall back to file path — use fs.readFileSync to avoid webpack dynamic require issues
  const filePath = process.env.FIREBASE_SERVICE_ACCOUNT
    || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (filePath) {
    const fs = require('fs');
    const path = require('path');
    const resolved = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    try {
      return JSON.parse(fs.readFileSync(resolved, 'utf8'));
    } catch (e) {
      throw new Error(`Failed to read service account file at ${resolved}: ${e.message}`);
    }
  }
  throw new Error('No GCP service account credentials found (FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT)');
}

async function getAccessToken() {
  if (_tokenCache && Date.now() < _tokenExpiry) return _tokenCache;

  const creds = getServiceAccountCredentials();
  const auth = new GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/monitoring.read'],
  });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  _tokenCache = tokenResponse.token;
  _tokenExpiry = Date.now() + 55 * 60 * 1000; // 55 minutes
  return _tokenCache;
}

function getProjectId() {
  return process.env.FIREBASE_PROJECT_ID
    || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID
    || 'facial-attendance-binus';
}

/**
 * Query GCP Cloud Monitoring time series.
 * @param {string} filter - metric filter string
 * @param {string} startISO - ISO8601 start time
 * @param {string} endISO - ISO8601 end time
 * @param {number} alignSecs - alignment period in seconds (e.g. 86400 for daily, 2592000 for monthly)
 * @param {string} aligner - ALIGN_SUM | ALIGN_MEAN | ALIGN_MAX
 */
async function queryTimeSeries(filter, startISO, endISO, alignSecs = 2592000, aligner = 'ALIGN_SUM') {
  const projectId = getProjectId();
  const token = await getAccessToken();

  const params = new URLSearchParams({
    filter,
    'interval.startTime': startISO,
    'interval.endTime': endISO,
    'aggregation.alignmentPeriod': `${alignSecs}s`,
    'aggregation.perSeriesAligner': aligner,
    'aggregation.crossSeriesReducer': 'REDUCE_SUM',
    'aggregation.groupByFields': 'resource.labels.function_name',
  });

  const url = `${GCP_MONITORING_BASE}/projects/${projectId}/timeSeries?${params}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GCP Monitoring API error ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Get total Cloud Function invocation count for a time range.
 * Returns { total, byFunction: { [name]: count } }
 */
async function queryFunctionInvocations(startISO, endISO, alignSecs = 2592000) {
  try {
    const filter = 'metric.type="cloudfunctions.googleapis.com/function/execution_count"';
    const data = await queryTimeSeries(filter, startISO, endISO, alignSecs);
    const series = data.timeSeries || [];

    const byFunction = {};
    let total = 0;
    for (const ts of series) {
      const fnName = ts.resource?.labels?.function_name || 'unknown';
      const count = (ts.points || []).reduce((sum, p) => sum + (Number(p.value?.int64Value || p.value?.doubleValue || 0)), 0);
      byFunction[fnName] = (byFunction[fnName] || 0) + count;
      total += count;
    }
    return { ok: true, total, byFunction };
  } catch (err) {
    return { ok: false, reason: err.message, total: 0, byFunction: {} };
  }
}

/**
 * Get total Cloud Function GB-seconds for a time range.
 */
async function queryFunctionGBSeconds(startISO, endISO, alignSecs = 2592000) {
  try {
    const filter = 'metric.type="cloudfunctions.googleapis.com/function/user_memory_bytes"';
    const data = await queryTimeSeries(filter, startISO, endISO, alignSecs, 'ALIGN_MEAN');
    const series = data.timeSeries || [];

    let totalGBs = 0;
    for (const ts of series) {
      const memBytes = (ts.points || []).reduce((sum, p) => sum + (Number(p.value?.doubleValue || 0)), 0);
      totalGBs += memBytes / (1024 * 1024 * 1024);
    }
    return { ok: true, totalGBs: Math.round(totalGBs * 100) / 100 };
  } catch (err) {
    return { ok: false, reason: err.message, totalGBs: 0 };
  }
}

/**
 * Get daily CF invocation counts for a time range (timeline view).
 * Returns array of { date: 'YYYY-MM-DD', count: number }
 */
async function queryFunctionInvocationsDaily(startISO, endISO) {
  try {
    const filter = 'metric.type="cloudfunctions.googleapis.com/function/execution_count"';
    const data = await queryTimeSeries(filter, startISO, endISO, 86400);
    const series = data.timeSeries || [];

    const byDay = {};
    for (const ts of series) {
      for (const point of ts.points || []) {
        const day = (point.interval?.startTime || point.interval?.endTime || '').slice(0, 10);
        if (!day) continue;
        byDay[day] = (byDay[day] || 0) + Number(point.value?.int64Value || point.value?.doubleValue || 0);
      }
    }

    return {
      ok: true,
      days: Object.entries(byDay)
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    };
  } catch (err) {
    return { ok: false, reason: err.message, days: [] };
  }
}

module.exports = {
  queryFunctionInvocations,
  queryFunctionGBSeconds,
  queryFunctionInvocationsDaily,
};
