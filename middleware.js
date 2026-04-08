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

// Prefixes to skip (static assets, API routes, Next.js internals)
const SKIP_PREFIXES = ['/_next', '/api/', '/favicon', '/models/', '/sw.js', '/manifest.json', '/binus-logo'];

export function middleware(request) {
  const { pathname } = request.nextUrl;

  // Skip static assets, API routes, and Next.js internals
  if (SKIP_PREFIXES.some(p => pathname.startsWith(p))) {
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
    const decoded = Buffer.from(session.value, 'base64').toString();
    const parts = decoded.split(':');
    const timestamp = parseInt(parts[parts.length - 1], 10);
    const SESSION_MAX_AGE_MS = 30 * 60 * 1000;

    if (isNaN(timestamp) || Date.now() - timestamp > SESSION_MAX_AGE_MS) {
      // Expired session — clear cookie and redirect
      const url = request.nextUrl.clone();
      url.pathname = '/login';
      url.searchParams.set('expired', '1');
      const response = NextResponse.redirect(url);
      response.cookies.delete('__session');
      return response;
    }
  } catch {
    // Malformed cookie — redirect to login
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
