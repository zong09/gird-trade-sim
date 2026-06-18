import express from 'express';
import crypto  from 'crypto';

// fixed credentials — overridable via env for deploy
const USER = process.env.AUTH_USER ?? 'admin';
const PASS = process.env.AUTH_PASS ?? 'admin';

const COOKIE = 'sid';

// valid session tokens, in-memory (cleared on restart — fine for fixed creds)
const sessions = new Set<string>();

function parseCookies(req: express.Request): Record<string, string> {
  const out: Record<string, string> = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// gate everything except the login page + login endpoint
export const requireAuth: express.RequestHandler = (req, res, next) => {
  if (req.path === '/login.html' || (req.method === 'POST' && req.path === '/api/login')) {
    return next();
  }
  const token = parseCookies(req)[COOKIE];
  if (token && sessions.has(token)) return next();

  if (req.path.startsWith('/api/')) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  res.redirect('/login.html');
};

export const login: express.RequestHandler = (req, res) => {
  const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
  if (username === USER && password === PASS) {
    const token = crypto.randomUUID();
    sessions.add(token);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/' });
    res.json({ ok: true });
    return;
  }
  res.status(401).json({ error: 'invalid credentials' });
};

export const logout: express.RequestHandler = (req, res) => {
  const token = parseCookies(req)[COOKIE];
  if (token) sessions.delete(token);
  res.clearCookie(COOKIE);
  res.json({ ok: true });
};
