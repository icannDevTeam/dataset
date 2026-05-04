/**
 * Kiosk profile helpers — pickup-display configuration stored per tenant.
 *
 * Firestore: tenants/{tid}/kiosk_profiles/{profileId}
 *   {
 *     name:        "PYP Lobby · Grade 1",
 *     gates:       ["PYP Lobby Entrance (DS-K1T342MFX)"],
 *     homerooms:   ["1A","1B","1C"],         // empty/missing = all
 *     showQueue:   true,
 *     maxCards:    5,
 *     beepEnabled: true,
 *     accent:      "#8B1538",
 *     windowOpen:  "14:30",                  // HH:MM, gate opens (local tz)
 *     windowClose: "16:00",                  //        gate closes
 *     suppressOutOfWindow: true,              // hide events outside window from TV
 *     createdAt, updatedAt
 *   }
 */
const tenancy = require('./tenancy');

const kioskProfilesPath = (t) => `${tenancy.tenantDoc(t)}/kiosk_profiles`;
const kioskProfileDoc = (id, t) => `${kioskProfilesPath(t)}/${id}`;

function normalizeProfile(id, data) {
  if (!data) return null;
  return {
    id,
    name: data.name || id,
    kioskCode: data.kioskCode || null,
    gates: Array.isArray(data.gates) ? data.gates : [],
    homerooms: Array.isArray(data.homerooms) ? data.homerooms : [],
    showQueue: data.showQueue !== false,
    maxCards: Math.max(1, Math.min(8, parseInt(data.maxCards, 10) || 5)),
    beepEnabled: data.beepEnabled !== false,
    accent: data.accent || '#8B1538',
    windowOpen: typeof data.windowOpen === 'string' && /^\d{2}:\d{2}$/.test(data.windowOpen) ? data.windowOpen : null,
    windowClose: typeof data.windowClose === 'string' && /^\d{2}:\d{2}$/.test(data.windowClose) ? data.windowClose : null,
    suppressOutOfWindow: data.suppressOutOfWindow !== false,
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null,
  };
}

// Returns minutes-since-midnight for an "HH:MM" string, or null.
function _hhmmToMinutes(s) {
  if (!s || typeof s !== 'string' || !/^\d{2}:\d{2}$/.test(s)) return null;
  const [h, m] = s.split(':').map((x) => parseInt(x, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

// Convert a JS Date to {minutes, hhmm} in Asia/Jakarta local time.
function _localMinutes(d) {
  // 'Asia/Jakarta' is UTC+7 (no DST), so we can shortcut for accuracy + speed.
  // If the deployment moves elsewhere this should switch to Intl.DateTimeFormat.
  const utc = d.getTime();
  const wib = new Date(utc + 7 * 60 * 60 * 1000);
  return wib.getUTCHours() * 60 + wib.getUTCMinutes();
}

/**
 * Compute current gate-open status against a profile's window.
 *   { configured, open, opensAt, closesAt, nextOpenLabel }
 * If no window is configured, returns { configured:false, open:true }.
 */
function gateStatus(profile, now = new Date()) {
  const open = _hhmmToMinutes(profile?.windowOpen);
  const close = _hhmmToMinutes(profile?.windowClose);
  if (open == null || close == null) {
    return { configured: false, open: true, opensAt: null, closesAt: null, nextOpenLabel: null };
  }
  const cur = _localMinutes(now);
  let isOpen;
  if (open <= close) {
    isOpen = cur >= open && cur <= close;
  } else {
    // window crosses midnight (e.g. 22:00 → 02:00)
    isOpen = cur >= open || cur <= close;
  }
  return {
    configured: true,
    open: isOpen,
    opensAt: profile.windowOpen,
    closesAt: profile.windowClose,
    nextOpenLabel: isOpen ? null : profile.windowOpen,
  };
}

/** Filter an events array against profile rules. */
function eventMatchesProfile(event, profile) {
  if (!profile) return true;
  // Gate filter
  if (profile.gates && profile.gates.length > 0) {
    if (!profile.gates.includes(event.gate)) return false;
  }
  // Homeroom filter — show event if ANY of its students match
  if (profile.homerooms && profile.homerooms.length > 0) {
    const set = new Set(profile.homerooms.map((h) => String(h).toUpperCase()));
    const studentsMatch = (event.students || []).some((s) => set.has(String(s.homeroom || '').toUpperCase()));
    // Also keep "red / unknown chaperone" events at matching gates so security
    // staff can act on them — they have no students to match by definition.
    const securityCard = event.cardState === 'red' || event.decision === 'unknown_chaperone';
    if (!studentsMatch && !securityCard) return false;
  }
  // Window filter — if profile has window + suppression, drop events that
  // were recorded outside the open window.
  if (profile.suppressOutOfWindow !== false) {
    const winOpen = _hhmmToMinutes(profile.windowOpen);
    const winClose = _hhmmToMinutes(profile.windowClose);
    if (winOpen != null && winClose != null) {
      const ts = event.recordedAt || event.scannedAt;
      const d = ts instanceof Date ? ts : (typeof ts === 'string' ? new Date(ts) : null);
      if (d && !Number.isNaN(d.getTime())) {
        const cur = _localMinutes(d);
        const inWin = winOpen <= winClose
          ? (cur >= winOpen && cur <= winClose)
          : (cur >= winOpen || cur <= winClose);
        if (!inWin) return false;
      }
    }
  }
  return true;
}

module.exports = {
  kioskProfilesPath,
  kioskProfileDoc,
  normalizeProfile,
  eventMatchesProfile,
  gateStatus,
};
