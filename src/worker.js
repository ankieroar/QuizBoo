import { normalizeQuiz, publicQuestion, scoreAnswer } from './logic.js';
import { getAccount, register, verifyAccount, startSession, endSession } from './accounts.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
const QUESTION_COUNTDOWN_MS = 3_000;
const RESULTS_HOLD_MS = 6_000;
const MAX_MULTIPART_BYTES = 150 * 1024 * 1024;
const MEDIA_PART_BYTES = 8 * 1024 * 1024;
const PRESENCE_WRITE_INTERVAL = 15_000;
const ONLINE_WINDOW = 45_000;
const MEDIA_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/ogg': '.ogv' };

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
const error = (message, status = 400, code) => json({ error: message, code }, status);
const token = () => crypto.randomUUID() + '-' + crypto.randomUUID();
function roomCode() {
  const arr = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(arr, b => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join('');
}
async function bodyJson(request) {
  if (Number(request.headers.get('content-length') || 0) > 250_000) throw new Error('Dữ liệu quiz quá lớn (tối đa 250 KB).');
  try { return await request.json(); } catch { throw new Error('Dữ liệu JSON không hợp lệ.'); }
}
const getRoom = (db, code) => db.prepare('SELECT * FROM rooms WHERE code = ?').bind(code).first();
async function mediaSigningKey(room) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(room.host_token), {name:'HMAC',hash:'SHA-256'}, false, ['sign','verify']);
}
async function mediaBytes(request, limit, exact = false) {
  const length = request.headers.get('content-length');
  const tooLarge = () => new HttpError('Kích thước dữ liệu tải lên không hợp lệ.', 413);
  if (length !== null && (Number(length)>limit || (exact && Number(length)!==limit))) throw tooLarge();
  if (!request.body) throw tooLarge();
  const reader = request.body.getReader();
  const bytes = new Uint8Array(length === null ? limit : Number(length));
  let size = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      if (value.byteLength > bytes.length-size) {
        await reader.cancel();
        throw tooLarge();
      }
      bytes.set(value,size);
      size += value.byteLength;
    }
  } finally { reader.releaseLock(); }
  if (!size || (exact && size!==limit)) throw tooLarge();
  return bytes.subarray(0,size);
}
async function multipartMedia(request, bucket, room, action) {
  const signingKey = await mediaSigningKey(room);
  if (action === 'start') {
    const {size,type} = await bodyJson(request);
    if (!Number.isInteger(size) || size<=MAX_MEDIA_BYTES || size>MAX_MULTIPART_BYTES) {
      throw new HttpError('File vượt giới hạn upload hoặc không cần chia phần.', 413);
    }
    if (!Object.hasOwn(MEDIA_TYPES,type)) throw new HttpError('Định dạng file không được hỗ trợ.', 415);
    const key = `rooms/${room.code}/${crypto.randomUUID()}${MEDIA_TYPES[type]}`;
    const upload = await bucket.createMultipartUpload(key,{httpMetadata:{contentType:type}});
    const session = btoa(JSON.stringify([key,upload.uploadId,size]));
    const signature = await crypto.subtle.sign('HMAC',signingKey,new TextEncoder().encode(session));
    return json({session:session+'.'+btoa(String.fromCharCode(...new Uint8Array(signature))),partBytes:MEDIA_PART_BYTES});
  }
  const [session,signature] = (request.headers.get('x-media-upload') || '').split('.');
  let verified = false;
  try {
    verified = await crypto.subtle.verify('HMAC',signingKey,Uint8Array.from(atob(signature),c=>c.charCodeAt(0)),new TextEncoder().encode(session));
  } catch { /* Reject malformed upload sessions. */ }
  if (!verified) throw new HttpError('Phiên tải file không hợp lệ.', 400);
  const [key,uploadId,size] = JSON.parse(atob(session));
  const count = Math.ceil(size/MEDIA_PART_BYTES);
  const upload = bucket.resumeMultipartUpload(key,uploadId);
  if (action === 'abort') {
    await upload.abort();
    return json({ok:true});
  }
  if (action === 'part') {
    const partNumber = Number(request.headers.get('x-media-part'));
    if (!Number.isInteger(partNumber) || partNumber<1 || partNumber>count) throw new HttpError('Phần tải lên không hợp lệ.', 400);
    const bytes = await mediaBytes(request,Math.min(MEDIA_PART_BYTES,size-(partNumber-1)*MEDIA_PART_BYTES),true);
    return json(await upload.uploadPart(partNumber,bytes));
  }
  const {parts} = await bodyJson(request);
  if (!Array.isArray(parts) || parts.length!==count ||
      parts.some((part,index)=>part?.partNumber!==index+1 || typeof part.etag!=='string' || !part.etag)) {
    throw new HttpError('File chưa được tải đủ các phần.', 400);
  }
  try { await upload.complete(parts); }
  catch (e) {
    const existing = await bucket.head(key);
    if (existing?.size!==size) throw e;
  }
  return json({url:`/api/media/${key}`,size});
}
async function isHost(db, room, secret, request) {
  const legacyAccess = !!secret && secret === room.host_token;
  const account = await getAccount(db, request);
  if (!legacyAccess && !account) return false;
  const owner = await db.prepare('SELECT username FROM room_owners WHERE room_code=?').bind(room.code).first();
  return owner ? account?.username === owner.username : legacyAccess;
}
async function checkHost(db, room, secret, request) {
  if (!await isHost(db, room, secret, request)) throw new HttpError('Bạn không có quyền điều khiển phòng.', 403);
}
class HttpError extends Error { constructor(message, status, code) { super(message); this.status = status; this.code = code; } }
async function publishScores(db, room, phase, transition) {
  // Publish totals with the phase change. A skipped question keeps its answers for the next result.
  const [changed] = await db.batch([transition, db.prepare(`UPDATE players SET score=totals.points
    FROM (SELECT player_id,SUM(points) AS points FROM answers WHERE room_code=? AND points>0 GROUP BY player_id) totals
    WHERE players.room_code=? AND players.id=totals.player_id AND players.score<>totals.points
      AND EXISTS (SELECT 1 FROM rooms WHERE code=? AND phase=? AND question_index=? AND question_started_at=?)`)
    .bind(room.code,room.code,room.code,phase,room.question_index,room.question_started_at)]);
  return changed;
}
async function refreshExpired(db, room) {
  const now = Date.now();
  if (room.phase === 'question' && now >= room.deadline) {
    await publishScores(db,room,'reveal',db.prepare(`UPDATE rooms SET phase='reveal',updated_at=?
      WHERE code=? AND phase='question' AND question_index=? AND question_started_at=? AND deadline<=?`)
      .bind(now,room.code,room.question_index,room.question_started_at,now));
    room = await getRoom(db, room.code);
  }
  return room;
}
async function getPlayer(db, code, secret) {
  if (!secret || typeof secret !== 'string') return null;
  return db.prepare(`SELECT p.id, p.name, p.score, s.last_seen, s.kicked
    FROM players p LEFT JOIN player_presence s ON s.player_id=p.id
    WHERE p.room_code=? AND p.player_token=?`).bind(code, secret).first();
}
function checkPlayer(player) {
  if (player?.kicked) throw new HttpError('Quản trò đã mời bạn ra khỏi phòng. Bạn có thể vào lại.', 403, 'PLAYER_KICKED');
  if (!player) throw new HttpError('Chưa tham gia phòng hoặc phiên đăng nhập đã hết hạn.', 401);
}
function recordPresence(db, id, secret, now) {
  return db.prepare(`INSERT INTO player_presence(player_id,last_seen)
    SELECT id,? FROM players WHERE id=? AND player_token=?
    ON CONFLICT(player_id) DO UPDATE SET last_seen=excluded.last_seen
    WHERE player_presence.kicked=0
      AND (player_presence.last_seen>=0 OR -player_presence.last_seen<excluded.last_seen)
      AND player_presence.last_seen<=excluded.last_seen`).bind(now,id,secret).run();
}
async function snapshot(db, room, credentials, request, requestTime) {
  room = await refreshExpired(db, room);
  const host = !credentials.playerToken && await isHost(db, room, credentials.hostToken, request);
  const player = await getPlayer(db, room.code, credentials.playerToken);
  if (!host) checkPlayer(player);
  const now = Date.now();
  if (player && (player.last_seen === null || player.last_seen <= now - PRESENCE_WRITE_INTERVAL)) {
    await recordPresence(db, player.id, credentials.playerToken, requestTime);
  }
  const players = await db.prepare(`SELECT p.id, p.name, p.score, a.player_id IS NOT NULL AS submitted
    FROM players p JOIN player_presence s ON s.player_id=p.id
    LEFT JOIN answers a ON a.room_code=p.room_code AND a.player_id=p.id AND a.question_index=?
    WHERE p.room_code=? AND s.kicked=0 AND s.last_seen>?
    ORDER BY p.score DESC, p.joined_at ASC, p.id ASC LIMIT 200`)
    .bind(room.question_index, room.code, now - ONLINE_WINDOW).all();
  const all = players.results || [];
  const quiz = JSON.parse(room.quiz_json);
  const idx = room.question_index;
  const phase = room.phase;
  const q = idx >= 0 ? quiz.questions[idx] : null;
  const answer = player && idx >= 0 ? await db.prepare('SELECT choice, is_correct, points FROM answers WHERE room_code=? AND player_id=? AND question_index=?')
    .bind(room.code, player.id, idx).first() : null;
  let answerCounts;
  if (phase==='reveal' && q) {
    const votes = await db.prepare('SELECT choice, COUNT(*) AS total FROM answers WHERE room_code=? AND question_index=? GROUP BY choice')
      .bind(room.code,idx).all();
    answerCounts=q.options.map(()=>0);
    for (const {choice,total} of votes.results) {
      if (choice>=0 && choice<answerCounts.length) answerCounts[choice]=total;
    }
  }
  const data = {
    code: room.code, title: room.title, phase, index: idx,
    total: quiz.questions.length, count: all.length,
    submitted: all.filter(p => p.submitted).length, deadline: room.deadline,
    startsAt: room.question_started_at,
    resultsUntil: phase==='reveal' ? room.updated_at + RESULTS_HOLD_MS : 0,
    serverReceivedAt: requestTime, serverNow: Date.now(),
    question: q && phase !== 'ended' ? publicQuestion(q, phase === 'reveal') : null,
    answerCounts,
    leaderboard: all.map((p, i) => ({ id: p.id, name: p.name, score: p.score, rank: i + 1 })),
    me: player ? { id: player.id, name: player.name, score: player.score,
      answer: answer ? (phase==='question' ? {choice:answer.choice}
        : {choice:answer.choice, correct:!!answer.is_correct, points:answer.points}) : null } : null,
    host
  };
  if (host) data.hostQuiz = quiz;
  return data;
}
async function routeApi(request, env, url) {
  const requestTime = Date.now();
  if (!env.DB) throw new HttpError('Thiếu binding DB. Xem README.md.', 503);
  const path = url.pathname;
  const origin = request.headers.get('origin');
  if (request.method === 'POST' && origin && origin !== url.origin) throw new HttpError('Yêu cầu không hợp lệ.', 403);
  if (path.startsWith('/api/account/') && request.method === 'POST') {
    if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) {
      throw new HttpError('Yêu cầu không hợp lệ.', 415);
    }
    const db = env.DB;
    if (path === '/api/account/logout') return json({ ok:true }, 200, await endSession(db, request));
    if (path === '/api/account/register' || path === '/api/account/login') {
      const {username, credential} = await bodyJson(request);
      if (typeof username !== 'string' || !/^[a-z0-9_]{3,24}$/.test(username) ||
          typeof credential !== 'string' || !/^[a-f0-9]{64}$/.test(credential)) {
        throw new HttpError('Tên người dùng hoặc mật khẩu không hợp lệ.', 400);
      }
      if (env.AUTH_LIMITER) {
        const ip = request.headers.get('CF-Connecting-IP') || 'local';
        const {success} = await env.AUTH_LIMITER.limit({key:ip});
        if (!success) throw new HttpError('Bạn đã thử quá nhiều lần. Hãy đợi một phút.', 429);
      }
      if (path.endsWith('/register')) {
        if (!await register(db, username, credential)) throw new HttpError('Tên người dùng đã được sử dụng.', 409);
      } else if (!await verifyAccount(db, username, credential)) {
        throw new HttpError('Sai tên người dùng hoặc mật khẩu.', 401);
      }
      return json({ username }, 200, await startSession(db, request, username));
    }
    const account = await getAccount(db, request);
    if (path === '/api/account/rooms') {
      const rooms = account ? (await db.prepare('SELECT r.code, r.title FROM room_owners o JOIN rooms r ON r.code=o.room_code WHERE o.username=? ORDER BY r.created_at DESC')
        .bind(account.username).all()).results : [];
      return json({ username:account?.username || null, rooms });
    }
    if (path === '/api/account/claim') {
      if (!account) throw new HttpError('Hãy đăng nhập để lưu phòng vào tài khoản.', 401);
      const {code, hostToken} = await bodyJson(request);
      if (typeof code !== 'string' || typeof hostToken !== 'string' || !hostToken) {
        throw new HttpError('Thiếu khóa quản trò.', 400);
      }
      const result = await db.prepare('INSERT INTO room_owners(room_code,username) SELECT code,? FROM rooms WHERE code=? AND host_token=? ON CONFLICT(room_code) DO NOTHING')
        .bind(account.username, code, hostToken).run();
      if (!result.meta.changes) throw new HttpError('Phòng đã được gắn tài khoản hoặc khóa quản trò không hợp lệ.', 403);
      return json({ ok:true });
    }
  }
  if (path === '/api/health' && request.method === 'GET') return json({ ok: true, r2: !!env.MEDIA });
  if (path === '/api/rooms' && request.method === 'POST') {
    const data = await bodyJson(request);
    const account = await getAccount(env.DB, request);
    if (data.requireAccount && !account) throw new HttpError('Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.', 401);
    const quiz = normalizeQuiz(data.quiz);
    const raw = JSON.stringify(quiz);
    if (new TextEncoder().encode(raw).length > 250_000) throw new HttpError('Quiz tối đa 250 KB. Nên tải media qua R2.', 413);
    const secret = token();
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = roomCode(), now = Date.now();
      try {
        const insert = env.DB.prepare('INSERT INTO rooms(code, host_token, quiz_json, title, phase, created_at, updated_at) VALUES(?,?,?,?,?,?,?)')
          .bind(code, secret, raw, quiz.title, 'lobby', now, now);
        if (account) {
          await env.DB.batch([insert, env.DB.prepare('INSERT INTO room_owners(room_code,username) VALUES(?,?)').bind(code, account.username)]);
        } else await insert.run();
        return json(account ? { code, hostToken:'' } : { code, hostToken:secret }, 201);
      } catch (e) { if (!/UNIQUE|constraint/i.test(String(e))) throw e; }
    }
    throw new HttpError('Không tạo được mã phòng, hãy thử lại.', 503);
  }
  const match = path.match(/^\/api\/rooms\/([A-HJ-NP-Z2-9]{6})(?:\/(state|join|leave|action|answer|quiz))?$/);
  if (match) {
    const code = match[1], op = match[2] || '';
    if (request.method !== 'POST') return error('Chỉ hỗ trợ POST.', 405);
    const room0 = await getRoom(env.DB, code);
    if (!room0) throw new HttpError('Không tìm thấy phòng. Kiểm tra lại mã nhé!', 404);
    const data = await bodyJson(request);
    if (op === 'join') {
      const room = await refreshExpired(env.DB, room0);
      const name = typeof data.name === 'string' ? data.name.trim().slice(0, 24) : '';
      if (!name) throw new HttpError('Hãy nhập tên người chơi.', 400);
      const existing = await getPlayer(env.DB, code, data.playerToken);
      const now = Date.now();
      if (existing?.kicked) {
        const secret = token();
        const [updated] = await env.DB.batch([
          env.DB.prepare(`UPDATE players SET player_token=? WHERE id=? AND player_token=?
            AND EXISTS (SELECT 1 FROM player_presence WHERE player_id=players.id AND kicked=1)`)
            .bind(secret,existing.id,data.playerToken),
          env.DB.prepare(`UPDATE player_presence SET kicked=0,last_seen=? WHERE player_id=?
            AND EXISTS (SELECT 1 FROM players WHERE id=player_presence.player_id AND player_token=?)`)
            .bind(now,existing.id,secret)
        ]);
        if (!updated.meta.changes) throw new HttpError('Phiên tham gia đã thay đổi. Hãy thử lại.', 409);
        return json({ playerToken: secret, playerId: existing.id });
      }
      if (room.phase !== 'lobby') throw new HttpError('Phòng đã bắt đầu. Vui lòng chờ phòng mới.', 409);
      if (existing) {
        await recordPresence(env.DB, existing.id, data.playerToken, now);
        return json({ playerToken: data.playerToken, playerId: existing.id });
      }
      const id = crypto.randomUUID(), secret = token();
      const [insert] = await env.DB.batch([
        env.DB.prepare(`INSERT INTO players(id,room_code,player_token,name,score,joined_at)
          SELECT ?,code,?,?,0,? FROM rooms WHERE code=? AND phase='lobby'
            AND (SELECT COUNT(*) FROM players WHERE room_code=rooms.code)<200`).bind(id,secret,name,now,code),
        env.DB.prepare(`INSERT INTO player_presence(player_id,last_seen)
          SELECT id,? FROM players WHERE id=?`).bind(now,id)
      ]);
      if (!insert.meta.changes) throw new HttpError('Phòng đã bắt đầu hoặc đã đủ 200 người.', 409);
      return json({ playerToken: secret, playerId: id }, 201);
    }
    if (op === 'state') return json(await snapshot(env.DB, room0, data, request, requestTime));
    if (op === 'leave') {
      if (typeof data.playerToken !== 'string' || !data.playerToken) throw new HttpError('Thiếu khóa người chơi.', 401);
      // A negative timestamp marks an explicit departure and blocks older polls from restoring presence.
      await env.DB.prepare(`INSERT INTO player_presence(player_id,last_seen)
        SELECT id,? FROM players WHERE room_code=? AND player_token=?
        ON CONFLICT(player_id) DO UPDATE SET last_seen=excluded.last_seen
        WHERE player_presence.kicked=0 AND abs(player_presence.last_seen)<=-excluded.last_seen`)
        .bind(-requestTime,code,data.playerToken).run();
      return json({ ok: true });
    }
    if (op === 'quiz') {
      await checkHost(env.DB, room0, data.hostToken, request);
      if (room0.phase !== 'lobby') throw new HttpError('Chỉ chỉnh quiz khi còn ở sảnh chờ.', 409);
      const quiz = normalizeQuiz(data.quiz);
      const raw = JSON.stringify(quiz);
      if (new TextEncoder().encode(raw).length > 250_000) throw new HttpError('Quiz tối đa 250 KB.', 413);
      const saved = await env.DB.prepare('UPDATE rooms SET quiz_json=?, title=?, updated_at=? WHERE code=? AND phase=\'lobby\'')
        .bind(raw,quiz.title,Date.now(),code).run();
      if (!saved.meta.changes) throw new HttpError('Chỉ chỉnh quiz khi còn ở sảnh chờ.', 409);
      return json({ ok: true });
    }
    if (op === 'action') {
      const room = await refreshExpired(env.DB, room0);
      await checkHost(env.DB, room, data.hostToken, request);
      const quiz = JSON.parse(room.quiz_json), now = Date.now();
      const act = data.action;
      if (act === 'kick') {
        if (typeof data.playerId !== 'string' || !data.playerId) throw new HttpError('Thiếu mã người chơi.', 400);
        const result = await env.DB.prepare(`INSERT INTO player_presence(player_id,last_seen,kicked)
          SELECT id,0,1 FROM players WHERE room_code=? AND id=?
          ON CONFLICT(player_id) DO UPDATE SET kicked=1,last_seen=0`).bind(code,data.playerId).run();
        if (!result.meta.changes) throw new HttpError('Không tìm thấy người chơi trong phòng.', 404);
      } else if (act === 'start' && room.phase === 'lobby') {
        const startsAt=now + QUESTION_COUNTDOWN_MS;
        await env.DB.prepare("UPDATE rooms SET phase='question',question_index=0,question_started_at=?,deadline=?+json_extract(quiz_json,'$.questions[0].time')*1000,updated_at=? WHERE code=? AND phase='lobby'")
          .bind(startsAt, startsAt, now, code).run();
      } else if (act === 'close-question') {
        if (room.phase!=='question' || data.index!==room.question_index || data.deadline!==room.deadline) {
          throw new HttpError('Câu hỏi đã đóng hoặc đã đổi.', 409);
        }
        if (now<room.question_started_at) throw new HttpError('Câu hỏi chưa bắt đầu.', 409);
        const closed = await publishScores(env.DB,room,'reveal',env.DB.prepare(`UPDATE rooms SET phase='reveal',updated_at=?
          WHERE code=? AND phase='question' AND question_index=? AND question_started_at=?`)
          .bind(now,code,room.question_index,room.question_started_at));
        if (!closed.meta.changes) throw new HttpError('Câu hỏi đã đóng hoặc đã đổi.', 409);
      } else if ((act === 'next' && room.phase === 'reveal') ||
                 (act === 'skip' && ['question','reveal'].includes(room.phase))) {
        const skipping = act === 'skip';
        if (room.phase==='reveal' && now<room.updated_at+RESULTS_HOLD_MS) {
          throw new HttpError('Chờ mọi người xem bảng điểm trước khi chuyển câu.', 409);
        }
        if (skipping && (data.index !== room.question_index || data.deadline !== room.deadline)) {
          throw new HttpError('Câu hỏi đã đổi. Hãy đồng bộ lại phòng.', 409);
        }
        const currentQuestion = `WHERE code=? AND question_index=? AND question_started_at=?
          AND (phase='reveal' OR (?=1 AND phase='question'))`;
        const expected = [code,room.question_index,room.question_started_at,Number(skipping)];
        let advanced;
        if (room.question_index + 1 >= quiz.questions.length) {
          advanced = await publishScores(env.DB,room,'ended',env.DB.prepare(`UPDATE rooms SET phase='ended',deadline=0,updated_at=? ${currentQuestion}`)
            .bind(now,...expected));
        } else {
          const j = room.question_index + 1;
          const startsAt=now + QUESTION_COUNTDOWN_MS;
          advanced = await env.DB.prepare(`UPDATE rooms SET phase='question',question_index=?,question_started_at=?,deadline=?,updated_at=? ${currentQuestion}`)
            .bind(j,startsAt,startsAt + quiz.questions[j].time * 1000,now,...expected).run();
        }
        if (!advanced.meta.changes) throw new HttpError('Câu hỏi đã đổi. Hãy đồng bộ lại phòng.', 409);
      } else if (act === 'end' && ['lobby','question','reveal'].includes(room.phase)) {
        const ended = await publishScores(env.DB,room,'ended',env.DB.prepare(`UPDATE rooms SET phase='ended',deadline=0,updated_at=?
          WHERE code=? AND phase IN ('lobby','question','reveal') AND question_index=? AND question_started_at=?`)
          .bind(now,code,room.question_index,room.question_started_at));
        if (!ended.meta.changes) throw new HttpError('Trạng thái phòng đã đổi. Hãy đồng bộ lại phòng.', 409);
      } else if (act === 'reset' && room.phase === 'ended') {
        await env.DB.batch([
          env.DB.prepare('DELETE FROM answers WHERE room_code=?').bind(code),
          env.DB.prepare('UPDATE players SET score=0 WHERE room_code=?').bind(code),
          env.DB.prepare("UPDATE rooms SET phase='lobby',question_index=-1,question_started_at=0,deadline=0,updated_at=? WHERE code=?").bind(now,code)
        ]);
      } else throw new HttpError('Thao tác không hợp lệ với trạng thái phòng.', 409);
      return json({ ok: true });
    }
    if (op === 'answer') {
      const room = await refreshExpired(env.DB, room0);
      const player = await getPlayer(env.DB, code, data.playerToken);
      checkPlayer(player);
      const now = Date.now();
      if (room.phase==='question' && now<room.question_started_at) throw new HttpError('Câu hỏi chưa bắt đầu.', 409);
      if (room.phase !== 'question' || now >= room.deadline ||
          (data.index !== undefined && data.index !== room.question_index) ||
          (data.deadline !== undefined && data.deadline !== room.deadline)) {
        throw new HttpError('Câu hỏi đã đóng.', 409);
      }
      const choice = data.choice;
      const quiz = JSON.parse(room.quiz_json), q = quiz.questions[room.question_index];
      const result = scoreAnswer(q, choice, now, room.question_started_at, room.deadline);
      const insert = await env.DB.prepare(`INSERT OR IGNORE INTO answers(room_code,player_id,question_index,choice,is_correct,points,answered_at)
          SELECT code,?,question_index,?,?,?,? FROM rooms
          WHERE code=? AND phase='question' AND question_index=? AND question_started_at=? AND deadline>?
            AND EXISTS (SELECT 1 FROM players p LEFT JOIN player_presence s ON s.player_id=p.id
              WHERE p.id=? AND p.player_token=? AND COALESCE(s.kicked,0)=0)`)
          .bind(player.id,choice,result.correct?1:0,result.points,now,code,room.question_index,room.question_started_at,now,player.id,data.playerToken).run();
      if (!insert.meta.changes) {
        checkPlayer(await getPlayer(env.DB, code, data.playerToken));
        const current = await getRoom(env.DB, code);
        if (current.phase !== 'question' || current.question_started_at !== room.question_started_at || current.question_index !== room.question_index) {
          throw new HttpError('Câu hỏi đã đóng.', 409);
        }
      }
      return json({ accepted: true }); // Không lộ đúng/sai trước pha reveal.
    }
    return error('Không tìm thấy API.', 404);
  }
  const multipart = path.match(/^\/api\/media\/multipart\/(start|part|complete|abort)$/);
  if ((path === '/api/media' || multipart) && request.method === 'POST') {
    if (!env.MEDIA) throw new HttpError('Chưa bật R2. Có thể dùng URL https:// hoặc xem hướng dẫn kích hoạt R2 trong README.', 503);
    const code = (request.headers.get('x-room-code') || '').toUpperCase();
    const secret = request.headers.get('x-host-token');
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) throw new HttpError('Mã phòng không hợp lệ.', 400);
    const room = await getRoom(env.DB, code);
    if (!room) throw new HttpError('Không tìm thấy phòng.', 404);
    await checkHost(env.DB, room, secret, request);
    if (room.phase !== 'lobby' && multipart?.[1]!=='abort') throw new HttpError('Chỉ tải media ở sảnh chờ.', 409);
    if (multipart) return multipartMedia(request,env.MEDIA,room,multipart[1]);
    const length = Number(request.headers.get('content-length') || 0);
    if (length > MAX_MEDIA_BYTES) throw new HttpError('File quá lớn. Tối đa 15 MB.', 413);
    const type = (request.headers.get('content-type') || '').split(';')[0].toLowerCase();
    const ext = Object.hasOwn(MEDIA_TYPES,type) ? MEDIA_TYPES[type] : null;
    if (!ext) throw new HttpError('Chỉ nhận PNG, JPG, WEBP, GIF, MP4, WEBM, OGG.', 415);
    const bytes = await mediaBytes(request,MAX_MEDIA_BYTES);
    const key = `rooms/${code}/${crypto.randomUUID()}${ext}`;
    await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: type } });
    return json({ url: `/api/media/${key}`, size: bytes.byteLength });
  }
  const media = path.match(/^\/api\/media\/(rooms\/[A-HJ-NP-Z2-9]{6}\/[a-z0-9-]+\.(?:png|jpg|webp|gif|mp4|webm|ogv))$/);
  if (media && ['GET','HEAD'].includes(request.method)) {
    if (!env.MEDIA) return error('Chưa cấu hình R2.', 503);
    const obj = await env.MEDIA.get(media[1], { range: request.headers });
    if (!obj) return error('Media không tồn tại.', 404);
    const headers = new Headers({ 'content-type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes' });
    headers.set('etag', obj.httpEtag);
    let status = 200;
    if (request.headers.has('range') && obj.range) {
      status = 206;
      const start = obj.range.offset ?? Math.max(0, obj.size - (obj.range.suffix || obj.range.length || obj.size));
      const length = obj.range.length ?? obj.size - start;
      headers.set('content-range', `bytes ${start}-${start + length - 1}/${obj.size}`);
      headers.set('content-length', String(length));
    } else headers.set('content-length', String(obj.size));
    if (request.method === 'HEAD') return new Response(null, { status, headers });
    return new Response(obj.body, { status, headers });
  }
  return error('Không tìm thấy API.', 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await routeApi(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (e) {
      if (e instanceof HttpError) return error(e.message, e.status, e.code);
      if (e instanceof Error && /no such table:\s*(?:accounts|account_sessions|room_owners|player_presence)\b/i.test(e.message)) {
        return error('Cơ sở dữ liệu chưa được cập nhật. Quản trị viên cần chạy npm run db:local hoặc npm run db:remote tùy môi trường.', 503);
      }
      if (e instanceof Error && /quiz|câu|đáp án|dữ liệu|thời gian|Lựa chọn/.test(e.message)) return error(e.message, 400);
      console.error('Worker error', e);
      return error('Lỗi máy chủ. Hãy kiểm tra cấu hình D1/R2 hoặc thử lại.', 500);
    }
  }
};
