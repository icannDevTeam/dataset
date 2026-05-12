/**
 * lib/otp.js — Server-side one-time password generator.
 *
 * Used to mint passwords sent in invite emails. Excludes ambiguous glyphs
 * (0/O/1/l/I) so users can copy the code from a phone screen without
 * second-guessing characters. 12 alphanumeric characters yields ~71 bits
 * of entropy — plenty for a single-use code that gets changed on first
 * login.
 */
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function generateOtp(len = 12) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

module.exports = { generateOtp };
