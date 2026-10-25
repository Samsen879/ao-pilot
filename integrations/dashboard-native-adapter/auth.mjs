import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';

// The managed release supplies one private capability to both terminal entry
// points. HTTP Basic lets an ordinary browser obtain an HttpOnly cookie; API
// clients use Bearer. No unauthenticated route issues the capability.
function readPrivate(file) {
  if (!path.isAbsolute(file)) throw new Error('Invalid terminal token file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o077)) throw new Error('Unsafe terminal token file');
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}
export function loadTerminalAuth(configFile, required = false) {
  if (!configFile) return createTerminalAuth(undefined, '', required);
  const config = JSON.parse(readPrivate(configFile));
  return createTerminalAuth(config.TERMINAL_TOKEN_FILE, config.TERMINAL_ORIGIN, required);
}
export function createTerminalAuth(file, origin, required = false) {
  if (!file) {
    if (required) throw new Error('Managed terminal authentication is required');
    return null;
  }
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.origin !== origin) throw new Error('Invalid terminal origin');
  const token = readPrivate(file).trim();
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) throw new Error('Invalid terminal token');
  const equal = (value) => {
    const a = Buffer.from(value); const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  return {
    originAllowed: (request) => request.headers.origin === origin,
    authenticate(request) {
      const authorization = request.headers.authorization;
      if (authorization !== undefined) {
        if (authorization.startsWith('Bearer ')) return equal(authorization.slice(7));
        const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(authorization);
        if (!match) return false;
        const value = Buffer.from(match[1], 'base64');
        if (value.toString('base64') !== match[1]) return false;
        const credentials = value.toString('utf8');
        return credentials.startsWith('ao:') && equal(credentials.slice(3));
      }
      const cookies = (request.headers.cookie ?? '').split(';').map((value) => value.trim()).filter((value) => value.startsWith('ao_terminal='));
      if (cookies.length !== 1) return false;
      try { return equal(decodeURIComponent(cookies[0].slice('ao_terminal='.length))); } catch { return false; }
    },
    cookie: `ao_terminal=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${url.protocol === 'https:' ? '; Secure' : ''}`,
  };
}
