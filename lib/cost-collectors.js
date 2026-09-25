/**
 * Individual data collectors for the Cost Monitor dashboard.
 * Each collector returns { ok: true, data: {...} } or { ok: false, reason: string, data: {} }.
 * All are non-throwing — errors are captured and surfaced as degraded cards.
 */

const https = require('https');
const tls = require('tls');

// ── Resend ───────────────────────────────────────────────────────────

/**
 * Fetch Resend email stats for a given month.
 * Uses /emails endpoint (returns list) and /domains for domain health.
 */
async function collectResend(monthStart, monthEnd) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, reason: 'RESEND_API_KEY not set', data: {} };

  try {
    // Fetch up to 100 recent emails (Resend free tier max is 3K/mo so 100 covers the sample)
    const res = await fetch('https://api.resend.com/emails?limit=100', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, reason: `Resend API ${res.status}: ${text.slice(0, 200)}`, data: {} };
    }
    const json = await res.json();
    const emails = Array.isArray(json.data) ? json.data : (Array.isArray(json) ? json : []);

    // Filter to current month using created_at
    const start = new Date(monthStart).getTime();
    const end = new Date(monthEnd).getTime();
    const monthEmails = emails.filter((e) => {
      const t = new Date(e.created_at || e.createdAt || 0).getTime();
      return t >= start && t < end;
    });

    // Count by status
    const byStatus = {};
    const byTemplate = {};
    for (const email of monthEmails) {
      const status = e_status(email);
      byStatus[status] = (byStatus[status] || 0) + 1;
      // Extract template type from subject or tags
      const template = detectTemplate(email);
      byTemplate[template] = (byTemplate[template] || 0) + 1;
    }

    const total = monthEmails.length;
    const delivered = (byStatus.delivered || 0) + (byStatus.sent || 0);
    const bounced = byStatus.bounced || byStatus.hard_bounced || 0;
    const deliveryRate = total > 0 ? Math.round((delivered / total) * 1000) / 10 : 100;

    // Free tier: 3,000/month
    const FREE_LIMIT = 3000;
    const usagePct = Math.round((total / FREE_LIMIT) * 100);

    return {
      ok: true,
      data: {
        total,
        delivered,
        bounced,
        deliveryRate,
        byStatus,
        byTemplate,
        freeLimit: FREE_LIMIT,
        usagePct,
        // Cost: $0 under 3K, $0.00015/email after
        estimatedCost: total > FREE_LIMIT ? ((total - FREE_LIMIT) * 0.00015).toFixed(4) : '0.00',
      },
    };
  } catch (err) {
    return { ok: false, reason: err.message, data: {} };
  }
}

function e_status(email) {
  return email.last_event || email.status || 'unknown';
}

function detectTemplate(email) {
  const subj = String(email.subject || '').toLowerCase();
  if (subj.includes('pickup') || subj.includes('released')) return 'pickup_child_released';
  if (subj.includes('onboard') || subj.includes('welcome') || subj.includes('invite')) return 'onboarding';
  if (subj.includes('report') || subj.includes('weekly')) return 'weekly_report';
  if (subj.includes('security') || subj.includes('alert')) return 'security_alert';
  return 'other';
}

// ── Anthropic / Claude ───────────────────────────────────────────────

/**
 * Fetch Anthropic API usage for the current month.
 * Supports two auth modes:
 *   1. Workspace-scoped key (ANTHROPIC_ADMIN_KEY alone) — standard scoped key
 *   2. Unscoped org-level key (ANTHROPIC_ADMIN_KEY + ANTHROPIC_WORKSPACE_ID) — service account key
 * Regular inference keys without admin role will fall back to setup guidance.
 */
async function collectAnthropic(monthStart, monthEnd) {
  const adminKey = process.env.ANTHROPIC_ADMIN_KEY;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;

  if (!adminKey && !apiKey) {
    return { ok: false, reason: 'ANTHROPIC_API_KEY not set', data: {} };
  }

  const keyToUse = adminKey || apiKey;

  if (keyToUse) {
    try {
      const startTime = monthStart || new Date(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1).toISOString();

      // Try the usage endpoint — requires Enterprise Admin API key (sk-ant-admin01-...)
      // Regular inference keys (sk-ant-api03-) will get 404 — that's expected
      const usageHeaders = {
        'x-api-key': keyToUse,
        'anthropic-version': '2023-06-01',
      };
      if (workspaceId) usageHeaders['anthropic-workspace-id'] = workspaceId;

      const usageRes = await fetch(
        `https://api.anthropic.com/v1/usage?start_time=${encodeURIComponent(startTime)}&limit=100`,
        { headers: usageHeaders },
      );

      if (usageRes.ok) {
        const json = await usageRes.json();
        const rows = Array.isArray(json.data) ? json.data : [];

        // Aggregate by model
        const byModel = {};
        let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0;
        const daily = {};

        for (const row of rows) {
          const model = row.model || 'unknown';
          if (!byModel[model]) byModel[model] = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
          byModel[model].inputTokens += row.input_tokens || 0;
          byModel[model].outputTokens += row.output_tokens || 0;
          byModel[model].cacheRead += row.cache_read_input_tokens || 0;
          byModel[model].cacheWrite += row.cache_creation_input_tokens || 0;
          byModel[model].requests += row.request_count || 0;
          totalInput += row.input_tokens || 0;
          totalOutput += row.output_tokens || 0;
          totalCacheRead += row.cache_read_input_tokens || 0;
          totalCacheWrite += row.cache_creation_input_tokens || 0;

          // Daily aggregation
          const day = (row.timestamp || '').slice(0, 10);
          if (day) {
            if (!daily[day]) daily[day] = { input: 0, output: 0, requests: 0 };
            daily[day].input += row.input_tokens || 0;
            daily[day].output += row.output_tokens || 0;
            daily[day].requests += row.request_count || 0;
          }
        }

        // Estimate cost per model using Anthropic pricing ($/MTok)
        const MODEL_PRICING = {
          'claude-sonnet-4-6': { input: 3, output: 15 },
          'claude-opus-4-8': { input: 15, output: 75 },
          'claude-haiku-4-5': { input: 0.80, output: 4 },
          'claude-sonnet-4-5': { input: 3, output: 15 },
        };
        let estimatedCost = 0;
        for (const [model, data] of Object.entries(byModel)) {
          const pricing = MODEL_PRICING[model] || MODEL_PRICING['claude-sonnet-4-6'];
          const cost = (data.inputTokens * pricing.input + data.outputTokens * pricing.output) / 1_000_000;
          byModel[model].estimatedCost = cost.toFixed(4);
          estimatedCost += cost;
        }

        return {
          ok: true,
          data: {
            source: 'admin_api',
            inputTokens: totalInput,
            outputTokens: totalOutput,
            cacheReadTokens: totalCacheRead,
            cacheWriteTokens: totalCacheWrite,
            totalTokens: totalInput + totalOutput,
            byModel,
            daily: Object.entries(daily).sort((a, b) => a[0].localeCompare(b[0])).map(([date, d]) => ({ date, ...d })),
            estimatedCost: estimatedCost.toFixed(4),
            consoleUrl: 'https://console.anthropic.com/settings/usage',
          },
        };
      }

      // Usage API not available (404) — verify inference key is valid via token count
      const checkRes = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
        method: 'POST',
        headers: { 'x-api-key': keyToUse, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'hi' }] }),
      });
      const keyValid = checkRes.ok;

      return {
        ok: false,
        reason: 'usage_api_unavailable',
        data: {
          keyValid,
          keyType: keyToUse.startsWith('sk-ant-admin') ? 'admin' : 'inference',
          setupNote: keyValid
            ? 'Your API key works for inference. Usage API requires an Enterprise Admin key (sk-ant-admin01-...). View usage manually in the console.'
            : 'API key appears invalid — check ANTHROPIC_ADMIN_KEY in .env.',
          consoleUrl: 'https://console.anthropic.com/settings/usage',
        },
      };
    } catch (err) {
      console.warn('[collectAnthropic] key error:', err.message);
    }
  }

  return {
    ok: false,
    reason: 'admin_key_required',
    data: {
      hasApiKey: !!apiKey,
      setupNote: 'Add ANTHROPIC_ADMIN_KEY to .env to enable usage tracking.',
      setupUrl: 'https://console.anthropic.com/settings/keys',
      consoleUrl: 'https://console.anthropic.com/settings/usage',
    },
  };
}

// ── Vercel ───────────────────────────────────────────────────────────

/**
 * Fetch Vercel deployment stats and project info.
 * Auto-discovers team scope: tries personal first, then each team the token can see.
 */
async function collectVercel() {
  const token = process.env.VERCEL_TOKEN;
  if (!token) return { ok: false, reason: 'VERCEL_TOKEN not set', data: {} };

  const headers = { Authorization: `Bearer ${token}` };

  try {
    // Discover all scopes: personal + teams
    const teamsRes = await fetch('https://api.vercel.com/v2/teams', { headers });
    const teamsJson = teamsRes.ok ? await teamsRes.json() : { teams: [] };
    const teams = Array.isArray(teamsJson.teams) ? teamsJson.teams : [];

    // Build scope list: personal first, then each team
    const scopes = [null, ...teams.map((t) => t.id)];

    let allProjects = [];
    let allDeployments = [];

    for (const teamId of scopes) {
      const qs = teamId ? `?teamId=${teamId}&limit=10` : '?limit=10';
      const [pRes, dRes] = await Promise.all([
        fetch(`https://api.vercel.com/v9/projects${qs}`, { headers }),
        fetch(`https://api.vercel.com/v6/deployments${qs.replace('limit=10', 'limit=20')}&state=READY`, { headers }),
      ]);
      if (pRes.ok) {
        const pJson = await pRes.json();
        allProjects.push(...(pJson.projects || []));
      }
      if (dRes.ok) {
        const dJson = await dRes.json();
        allDeployments.push(...(dJson.deployments || []));
      }
    }

    // Deduplicate by id
    const seenP = new Set(); allProjects = allProjects.filter((p) => seenP.has(p.id) ? false : seenP.add(p.id));
    const seenD = new Set(); allDeployments = allDeployments.filter((d) => seenD.has(d.uid) ? false : seenD.add(d.uid));

    // Sort deployments newest first
    allDeployments.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    if (allProjects.length === 0 && allDeployments.length === 0) {
      return {
        ok: false,
        reason: 'token_scope_mismatch',
        data: {
          setupNote: 'Token has no projects. Create a token from the Vercel account that owns dataset-sigma.vercel.app.',
          setupUrl: 'https://vercel.com/account/tokens',
        },
      };
    }

    return {
      ok: true,
      data: {
        totalDeployments: allDeployments.length,
        projects: allProjects.map((p) => ({ id: p.id, name: p.name, framework: p.framework || null })),
        recentDeploys: allDeployments.slice(0, 10).map((d) => ({
          id: d.uid,
          name: d.name || d.projectId,
          url: d.url ? `https://${d.url}` : null,
          state: d.state,
          createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null,
          source: d.meta?.githubCommitRef || d.meta?.gitBranch || null,
        })),
        estimatedCost: '0.00',
      },
    };
  } catch (err) {
    return { ok: false, reason: err.message, data: {} };
  }
}

// ── GitHub Copilot ───────────────────────────────────────────────────

/**
 * Fetch GitHub Copilot billing and usage data.
 * Tries org-level first, falls back to user-level.
 */
async function collectGitHubCopilot() {
  // GITHUB_COPILOT_TOKEN: personal account token where Copilot subscription lives
  // Falls back to GITHUB_TOKEN if not set
  const token = process.env.GITHUB_COPILOT_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) return { ok: false, reason: 'GITHUB_TOKEN not set', data: {} };

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  try {
    // Fine-grained PATs (github_pat_) don't support manage_billing:copilot —
    // that scope only exists on classic PATs. Detect and surface guidance.
    const isFineGrained = token.startsWith('github_pat_');

    // Try org-level billing
    const orgRes = await fetch('https://api.github.com/orgs/icannDevTeam/copilot/billing', { headers });
    if (orgRes.ok) {
      const orgData = await orgRes.json();
      const seats = orgData.seat_breakdown?.total || orgData.total_seats || 0;
      const active = orgData.seat_breakdown?.active_this_cycle || seats;
      const costPerSeat = 19;
      return {
        ok: true,
        data: {
          source: 'org',
          org: 'icannDevTeam',
          totalSeats: seats,
          activeSeats: active,
          planType: orgData.plan_type || 'Business',
          estimatedCost: (active * costPerSeat).toFixed(2),
          perSeatPrice: costPerSeat,
        },
      };
    }

    // Try user-level
    const userRes = await fetch('https://api.github.com/user/copilot', { headers });
    if (userRes.ok) {
      const userData = await userRes.json();
      return {
        ok: true,
        data: {
          source: 'user',
          enabled: !!userData.enabled,
          planType: userData.copilot_plan || 'Individual',
          estimatedCost: userData.enabled ? '10.00' : '0.00',
          perSeatPrice: 10,
          totalSeats: userData.enabled ? 1 : 0,
          activeSeats: userData.enabled ? 1 : 0,
        },
      };
    }

    // Both 404 — give specific guidance based on token type
    if (isFineGrained) {
      return {
        ok: false,
        reason: 'fine_grained_pat',
        data: {
          setupNote: 'Fine-grained PATs cannot read Copilot billing. Create a classic PAT with manage_billing:copilot + read:org scopes.',
          setupUrl: 'https://github.com/settings/tokens/new',
        },
      };
    }

    return {
      ok: false,
      reason: 'no_copilot_subscription',
      data: {
        setupNote: 'No GitHub Copilot subscription found on icannDevTeam. May be on a personal account.',
        setupUrl: 'https://github.com/features/copilot',
      },
    };
  } catch (err) {
    return { ok: false, reason: err.message, data: {} };
  }
}

// ── Domain / SSL cert health ─────────────────────────────────────────

/**
 * Check SSL certificate expiry for a list of domains.
 * Returns array of { domain, daysRemaining, validTo, ok }
 */
async function collectDomainHealth(domainsEnv) {
  const domainList = String(domainsEnv || process.env.MONITOR_DOMAINS || '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);

  if (domainList.length === 0) {
    return { ok: true, data: { domains: [] } };
  }

  const results = await Promise.all(domainList.map(checkDomain));
  return { ok: true, data: { domains: results } };
}

function checkDomain(hostname) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ domain: hostname, ok: false, reason: 'timeout', daysRemaining: null, validTo: null });
    }, 8000);

    try {
      const socket = tls.connect({ host: hostname, port: 443, servername: hostname, rejectUnauthorized: false }, () => {
        clearTimeout(timeout);
        try {
          const cert = socket.getPeerCertificate();
          socket.destroy();
          if (!cert || !cert.valid_to) {
            return resolve({ domain: hostname, ok: false, reason: 'no_cert', daysRemaining: null, validTo: null });
          }
          const validTo = new Date(cert.valid_to);
          const daysRemaining = Math.floor((validTo.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
          resolve({ domain: hostname, ok: true, daysRemaining, validTo: validTo.toISOString() });
        } catch (e) {
          resolve({ domain: hostname, ok: false, reason: e.message, daysRemaining: null, validTo: null });
        }
      });
      socket.on('error', (err) => {
        clearTimeout(timeout);
        socket.destroy();
        resolve({ domain: hostname, ok: false, reason: err.message, daysRemaining: null, validTo: null });
      });
    } catch (err) {
      clearTimeout(timeout);
      resolve({ domain: hostname, ok: false, reason: err.message, daysRemaining: null, validTo: null });
    }
  });
}

module.exports = {
  collectResend,
  collectAnthropic,
  collectVercel,
  collectGitHubCopilot,
  collectDomainHealth,
};
