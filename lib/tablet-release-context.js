const tenancy = require('./tenancy');
const { effectiveGateStatus } = require('./terminal-gate');
const { openReleaseScopeTokens } = require('./manual-pickup');

async function resolveTabletReleaseContext(db, tenantId, token, now = new Date()) {
  const deviceSnap = await db.collection(tenancy.tabletDevicesPath(tenantId))
    .where('deviceToken', '==', String(token || ''))
    .limit(1)
    .get();
  if (deviceSnap.empty) return { error: 'unknown token', status: 401 };

  const device = deviceSnap.docs[0];
  const deviceData = device.data() || {};
  if (deviceData.status !== 'paired') return { error: 'not paired', status: 401 };
  const releaseGroupId = deviceData.releaseGroupId;
  if (!releaseGroupId) return { error: 'no release group bound', status: 409 };

  const groupSnap = await db.doc(tenancy.releaseGroupDoc(releaseGroupId, tenantId)).get();
  if (!groupSnap.exists) return { error: 'release group not found', status: 404 };
  const releaseGroup = groupSnap.data() || {};
  const terminalIds = Array.isArray(releaseGroup.terminalIds) ? releaseGroup.terminalIds.filter(Boolean) : [];
  if (terminalIds.length === 0) return { error: 'release group has no terminals', status: 409 };

  const terminalSnaps = await db.getAll(
    ...terminalIds.map((id) => db.doc(tenancy.terminalDoc(id, tenantId)))
  );
  const terminals = terminalSnaps
    .filter((snap) => snap.exists)
    .map((snap) => ({ id: snap.id, ...(snap.data() || {}) }));
  if (terminals.length === 0) return { error: 'release group terminals not found', status: 409 };

  const settingsSnap = await db.doc(tenancy.pickupSettingsDoc(tenantId)).get().catch(() => null);
  const settings = settingsSnap?.exists ? (settingsSnap.data() || {}) : {};
  const gateStates = terminals.map((terminal) => effectiveGateStatus(
    terminal, releaseGroup, now, settings
  ));

  return {
    tenantId,
    device: { id: device.id, ...deviceData },
    releaseGroup: { id: groupSnap.id, ...releaseGroup },
    terminals,
    scopeTokens: openReleaseScopeTokens(terminals, gateStates, releaseGroup),
    gateStates,
    inWindow: gateStates.some((state) => state.open),
  };
}

module.exports = { resolveTabletReleaseContext };