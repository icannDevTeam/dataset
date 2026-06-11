/**
 * Shared password strength rules — used by change-password (logged-in)
 * and reset-password (email link) so the policy can't drift.
 *
 * @returns {string|null} human-readable error, or null when valid.
 */
function validatePassword(pw) {
  if (!pw || typeof pw !== 'string') return 'Password is required.';
  if (pw.length < 10) return 'Password must be at least 10 characters.';
  if (!/[a-z]/.test(pw)) return 'Password must contain a lowercase letter.';
  if (!/[A-Z]/.test(pw)) return 'Password must contain an uppercase letter.';
  if (!/[0-9]/.test(pw)) return 'Password must contain a digit.';
  return null;
}

module.exports = { validatePassword };
