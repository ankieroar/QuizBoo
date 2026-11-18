const encoder = new TextEncoder();
const sessionAge = 7 * 24 * 60 * 60;
const sessionName = 'tq-session';
const hex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
const random = length => hex(crypto.getRandomValues(new Uint8Array(length)));

async function digest(value) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

function sessionToken(request) {
  return request.headers.get('cookie')?.match(/(?:^|;\s*)tq-session=([a-f0-9]{64})(?=;|$)/)?.[1];
}

export async function getAccount(db, request) {
  const token = sessionToken(request);
  if (!token) return null;
  return db.prepare('SELECT username FROM account_sessions WHERE token_hash=? AND expires_at>?')
    .bind(await digest(token), Date.now()).first();
}

function cookie(request, value, age) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return { 'Set-Cookie': `${sessionName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure}` };
}

export async function endSession(db, request) {
  const token = sessionToken(request);
  if (token) await db.prepare('DELETE FROM account_sessions WHERE token_hash=?').bind(await digest(token)).run();
  return cookie(request, '', 0);
}

export async function startSession(db, request, username) {
  const token = random(32), now = Date.now();
  const previous = sessionToken(request);
  const cleanup = previous
    ? db.prepare('DELETE FROM account_sessions WHERE token_hash=? OR expires_at<=?').bind(await digest(previous), now)
    : db.prepare('DELETE FROM account_sessions WHERE expires_at<=?').bind(now);
  await db.batch([
    cleanup,
    db.prepare('INSERT INTO account_sessions(token_hash,username,expires_at) VALUES(?,?,?)')
      .bind(await digest(token), username, now + sessionAge * 1000)
  ]);
  return cookie(request, token, sessionAge);
}

export async function register(db, username, credential) {
  const salt = random(16);
  const result = await db.prepare('INSERT INTO accounts(username,salt,verifier) VALUES(?,?,?) ON CONFLICT(username) DO NOTHING')
    .bind(username, salt, await digest(salt + credential)).run();
  return result.meta.changes > 0;
}

export async function verifyAccount(db, username, credential) {
  const account = await db.prepare('SELECT salt, verifier FROM accounts WHERE username=?').bind(username).first();
  const actual = await digest((account?.salt || '0'.repeat(32)) + credential);
  const expected = account?.verifier || '0'.repeat(64);
  let difference = 0;
  for (let i = 0; i < actual.length; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return !!account && difference === 0;
}
