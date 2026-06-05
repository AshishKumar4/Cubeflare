import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { hashPassword, normalizeEmail, randomBase64Url, sha256Hex, verifyPassword } from './crypto';
import { getClientIpPrefix, HttpError, isSafeOrigin, problem } from './http';
import { authPasswordPepper } from './secrets';
import type { AppEnv, AuthenticatedUser, HonoBindings } from './types';

const COOKIE_NAME = '__Host-cubeflare_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;

type SessionParts = {
  userId: string;
  token: string;
};

export function requireAuth(): MiddlewareHandler<HonoBindings> {
  return async (c, next) => {
    if (!isSafeOrigin(c.req.raw)) {
      return problem(403, 'bad_origin', 'Mutating requests must come from the same origin');
    }

    const user = await authenticateRequest(c);
    if (!user) {
      return problem(401, 'not_authenticated', 'Login required');
    }
    c.set('user', user);
    await next();
  };
}

export async function authenticateRequest(
  c: Context<HonoBindings>
): Promise<AuthenticatedUser | null> {
  const cookie = getCookie(c, COOKIE_NAME);
  const parts = parseSessionCookie(cookie);
  if (!parts) return null;
  const idHash = await sha256Hex(parts.token);
  const user = await getUserStub(c.env, parts.userId).validateSession({
    idHash,
    now: new Date().toISOString()
  });
  return user;
}

export async function registerUser(
  env: AppEnv,
  input: { email: string; password: string; displayName?: string },
  request: Request
): Promise<{ user: AuthenticatedUser; cookieToken: string; expiresAt: string }> {
  const pepper = await authPasswordPepper(env);
  const email = normalizeEmail(input.email);
  validateEmail(email);
  validatePassword(input.password);

  const userId = crypto.randomUUID();
  const registry = env.IDENTITY_REGISTRY.getByName('primary');
  const reservation = await registry.reserveEmail(email, userId);
  if (!reservation.ok) {
    throw new HttpError(409, 'email_taken', 'An account already exists for this email');
  }

  const salt = randomBase64Url(16);
  const passwordHash = await hashPassword(input.password, salt, pepper);
  const displayName = cleanDisplayName(input.displayName ?? email.split('@')[0]);
  const userStub = getUserStub(env, userId);
  await userStub.createAccount({
    id: userId,
    email,
    displayName,
    passwordSalt: salt,
    passwordHash
  });

  const session = await createSessionForUser(env, userId, request);
  return {
    user: {
      userId,
      email,
      displayName,
      sessionId: await sha256Hex(session.token)
    },
    cookieToken: formatSessionCookie({ userId, token: session.token }),
    expiresAt: session.expiresAt
  };
}

export async function loginUser(
  env: AppEnv,
  input: { email: string; password: string },
  request: Request
): Promise<{ user: AuthenticatedUser; cookieToken: string; expiresAt: string }> {
  const pepper = await authPasswordPepper(env);
  const email = normalizeEmail(input.email);
  validateEmail(email);
  const identity = await env.IDENTITY_REGISTRY.getByName('primary').lookup(email);
  if (!identity) {
    throw new HttpError(401, 'invalid_credentials', 'Invalid email or password');
  }

  const userStub = getUserStub(env, identity.userId);
  const profile = await userStub.getProfile();
  if (!profile) {
    throw new HttpError(401, 'invalid_credentials', 'Invalid email or password');
  }

  const validPassword = await verifyPassword(
    input.password,
    profile.passwordSalt,
    pepper,
    profile.passwordHash
  );
  if (!validPassword) {
    throw new HttpError(401, 'invalid_credentials', 'Invalid email or password');
  }

  const session = await createSessionForUser(env, profile.id, request);
  return {
    user: {
      userId: profile.id,
      email: profile.email,
      displayName: profile.displayName,
      sessionId: await sha256Hex(session.token)
    },
    cookieToken: formatSessionCookie({ userId: profile.id, token: session.token }),
    expiresAt: session.expiresAt
  };
}

export async function logoutUser(c: Context<HonoBindings>): Promise<void> {
  const cookie = getCookie(c, COOKIE_NAME);
  const parts = parseSessionCookie(cookie);
  if (parts) {
    const idHash = await sha256Hex(parts.token);
    await getUserStub(c.env, parts.userId).revokeSession(idHash);
  }
  deleteCookie(c, COOKIE_NAME, {
    path: '/',
    secure: shouldUseSecureCookie(c.req.raw)
  });
}

export function setSessionCookie(
  c: Context<HonoBindings>,
  value: string,
  expiresAt: string
): void {
  setCookie(c, COOKIE_NAME, value, {
    path: '/',
    httpOnly: true,
    secure: shouldUseSecureCookie(c.req.raw),
    sameSite: 'Lax',
    expires: new Date(expiresAt),
    priority: 'High'
  });
}

export function getUserStub(env: AppEnv, userId: string) {
  return env.USER_DO.getByName(userId);
}

async function createSessionForUser(env: AppEnv, userId: string, request: Request) {
  const token = randomBase64Url(32);
  const idHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await getUserStub(env, userId).createSession({
    idHash,
    expiresAt,
    userAgent: request.headers.get('User-Agent') ?? undefined,
    ipPrefix: getClientIpPrefix(request)
  });
  return { token, expiresAt };
}

function parseSessionCookie(value: string | undefined): SessionParts | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, userId, token] = parts;
  if (!/^[0-9a-f-]{36}$/.test(userId) || token.length < 32) return null;
  return { userId, token };
}

function formatSessionCookie(parts: SessionParts): string {
  return `v1.${parts.userId}.${parts.token}`;
}

function validateEmail(email: string): void {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
    throw new HttpError(400, 'invalid_email', 'Enter a valid email address');
  }
}

function validatePassword(password: string): void {
  if (password.length < 12) {
    throw new HttpError(400, 'weak_password', 'Password must be at least 12 characters');
  }
  if (password.length > 512) {
    throw new HttpError(400, 'password_too_long', 'Password is too long');
  }
}

function cleanDisplayName(value: string): string {
  const cleaned = value.trim().replace(/\s+/g, ' ').slice(0, 80);
  return cleaned || 'Player';
}

function shouldUseSecureCookie(request: Request): boolean {
  const url = new URL(request.url);
  return url.protocol === 'https:' || url.hostname !== 'localhost';
}
