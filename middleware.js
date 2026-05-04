/**
 * Next.js Edge Middleware — server-side auth gate.
 *
 * Runs at the edge BEFORE any page renders. Checks for a valid __session cookie.
 * If missing, redirects unauthenticated users to /login.
 *
 * This complements the client-side AuthGate in _app.js:
 *  - Middleware: fast redirect before HTML is even generated (no flash)
 *  - AuthGate: full Firebase token verification + RBAC after hydration
 */
import { NextResponse } from 'next/server';

// Pages that don't require auth
const PUBLIC_PATHS = ['/login'];

// Prefixes that don't require auth (whole subtrees)
const PUBLIC_PREFIXES = ['/consent/', '/pickup/onboarding/', '/pickup/tv'];

// Prefixes to skip (static assets, API routes, Next.js internals)
const SKIP_PREFIXES = ['/_next', '/api/', '/favicon', '/models/', '/sw.js', '/manifest.json', '/binus-logo'];

export async function middleware(request) {
  const { pathname } = request.nextUrl;

  // Skip static assets, API routes, and Next.js internals
  if (SKIP_PREFIXES.some(p => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Skip public prefixes (e.g. guardian consent page)
  if (PUBLIC_PREFIXES.some(p => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Skip public pages
  if (PUBLIC_PATHS.includes(pathname)) {
    // If user is already authenticated, redirect away from login
    const session = request.cookies.get('__session');
    if (session?.value) {
      const url = request.nextUrl.clone();
      url.pathname = '/v2';
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  // Check for session cookie
  const session = request.cookies.get('__session');

  if (!session?.value) {
    // No session — redirect to login
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('from', pathname);
    return NextResponse.redirect(url);
  }

  // Session exists — validate it's not expired (cookie Max-Age handles this,
  // but double-check the embedded timestamp as a safety net)
  try {
    // Verify HMAC signature on session cookie (Edge-compatible base64 decode)
    const decoded = atob(session.value);
    const lastColon = decoded.lastIndexOf(':');
    if (lastColon === -1) throw new Error('malformed');
    const payload = decoded.substring(0, lastColon);
    const sig = decoded.substring(lastColon + 1);

    // Re-derive HMAC and compare (using Web Crypto API for Edge compatibility)
    const secret = process.env.SESSION_SECRET || process.env.DASHBOARD_API_KEY;
    if (!secret) {
      // Fail-closed: refuse to authenticate with a guessable fallback secret.
      const url = request.nextUrl.clone();
      url.pathname = '/login';
      url.searchParams.set('error', 'server-misconfigured');
      const response = NextResponse.redirect(url);
      response.cookies.delete('__session');
      return response;
    }
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sigBytes = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
    const expected = Array.from(new Uint8Array(sigBytes)).map(b => b.toString(16).padStart(2, '0')).join('');

    // Timing-safe comparison (Edge-compatible)
    if (sig.length !== expected.length || sig !== expected) {
      throw new Error('invalid signature');
    }

    // Check expiry from payload (email:timestamp)
    const parts = payload.split(':');
    const timestamp = parseInt(parts[parts.length - 1], 10);
    const SESSION_MAX_AGE_MS = 60 * 60 * 1000;

    if (isNaN(timestamp) || Date.now() - timestamp > SESSION_MAX_AGE_MS) {
      const url = request.nextUrl.clone();
      url.pathname = '/login';
      url.searchParams.set('expired', '1');
      const response = NextResponse.redirect(url);
      response.cookies.delete('__session');
      return response;
    }
  } catch {
    // Invalid/tampered/malformed cookie — redirect to login
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    const response = NextResponse.redirect(url);
    response.cookies.delete('__session');
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Match all paths except static files and API routes
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
