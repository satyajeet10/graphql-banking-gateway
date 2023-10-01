import { SignJWT, jwtVerify } from 'jose';
import type { Role } from './db.js';

const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? 'dev-only-secret-change-me-0123456789abcdef');

export interface Viewer {
  id: string;
  role: Role;
}

export async function signToken(viewer: Viewer, expiresIn = '1h'): Promise<string> {
  return new SignJWT({ role: viewer.role }).setProtectedHeader({ alg: 'HS256' }).setSubject(viewer.id)
    .setIssuedAt().setExpirationTime(expiresIn).sign(secret);
}

/** Returns the viewer for a valid Bearer token, or null (anonymous). Never throws on bad input. */
export async function viewerFromHeader(header: string | null): Promise<Viewer | null> {
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    if (!payload.sub || (payload.role !== 'CUSTOMER' && payload.role !== 'ADMIN')) return null;
    return { id: payload.sub, role: payload.role };
  } catch {
    return null;
  }
}
