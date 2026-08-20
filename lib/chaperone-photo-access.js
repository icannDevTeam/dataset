function allowChaperoneAction(target, action, status) {
  if (target !== 'chaperone') return false;
  if (!['add-face', 'delete-face'].includes(action)) return false;
  const okStatuses = new Set(['pending', 'changes_requested', 'approved']);
  return okStatuses.has(String(status || ''));
}

module.exports = { allowChaperoneAction };
