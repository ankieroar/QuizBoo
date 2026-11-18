/* QuizBoo: một file JS thuần. Backend nằm trong src/worker.js. */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const state = {
  view: 'home', draft: null, selected: 0, files: new Map(), pendingRoom: null, editingRoom: null,
  role: null, code: '', hostToken: '', playerToken: '', room: null,
  timer: null, poller: null, busy: false, roomSession: 0, stageKey: '', serverSkew: 0,
  uploadCache: new Map(), account: { username:null, rooms:[] }, hostActionPending:null
};
const symbols = ['▲','◆','●','■','✦','⬟','♥','⬢'];
let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast'); el.textContent = message; el.classList.toggle('error', isError); el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.hidden = true, 4800);
}
function setView(view) {
  for (const id of ['home','editor','room']) $('#' + id).hidden = id !== view;
  const previousView = state.view;
  state.view = view;
  if (view === 'home' && (previousView === 'room' || state.editingRoom)) history.replaceState({}, '', location.pathname);
  if (view === 'home') {
    renderSavedRooms();
    refreshAccount().catch(e=>toast(e.message,true));
  }
  $('#top-home').hidden = view === 'home';
  if (view !== 'room') {
    clearInterval(state.poller); clearInterval(state.timer); state.poller = null;
    state.roomSession++; state.busy = false;
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function renderSavedRooms() {
  const list = $('#saved-room-list');
  const owned = new Set(state.account.rooms.map(room=>room.code));
  const localRooms = Object.keys(localStorage)
    .filter(key => /^tq-host-[A-HJ-NP-Z2-9]{6}$/.test(key) && localStorage.getItem(key))
    .map(key => {
      const code = key.slice('tq-host-'.length);
      return { code, title: localStorage.getItem('tq-room-title-'+code) };
    })
    .filter(room=>!owned.has(room.code));
  const rooms = [...state.account.rooms, ...localRooms]
    .sort((a, b) => (a.title || a.code).localeCompare(b.title || b.code, 'vi') || a.code.localeCompare(b.code));

  const username = state.account.username;
  $('#account-form').hidden = !!username;
  $('#account-active').hidden = !username;
  $('#account-name').textContent = username || '';
  $('#saved-rooms-hint').textContent = username
    ? 'Phòng trong tài khoản có thể mở lại trên thiết bị khác.'
    : 'Đăng nhập để lưu phòng vào tài khoản. Phòng khách được lưu trên trình duyệt này.';
  list.innerHTML = rooms.map(({code, title}) => `<li>
    <div><strong>${esc(title || 'Phòng quiz')}</strong><span>Mã phòng ${code} · ${owned.has(code)?'Trong tài khoản':'Trên trình duyệt'}</span></div>
    <div class="account-buttons">
      ${username&&!owned.has(code)?`<button type="button" class="button subtle" data-claim-room="${code}">Gắn vào tài khoản</button>`:''}
      <button type="button" class="button subtle" data-open-room="${code}" aria-label="Mở phòng ${code}">Mở lại →</button>
    </div>
  </li>`).join('');
}
async function refreshAccount() {
  state.account = await api('/api/account/rooms', {});
  renderSavedRooms();
}
async function accountCredential(username, password) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name:'PBKDF2', hash:'SHA-256', iterations:600_000,
    salt:encoder.encode(`QuizBoo account v1|${location.origin}|${username}`)
  }, key, 256);
  return Array.from(new Uint8Array(bits), value=>value.toString(16).padStart(2,'0')).join('');
}
function freshQuestion() { return { q: '', options: ['','','',''], answer: 0, hidden: null, media: '', revealMedia: '', explanation: '', time: 20 }; }
function freshDraft() { return { title: 'Troll Quiz cùng hội bạn', time: 20, questions: [freshQuestion()] }; }
function currentQ() { return state.draft.questions[state.selected]; }
function openEditor(draft = freshDraft(), editingRoom = null) {
  state.draft = draft; state.selected = 0; state.pendingRoom = null; state.uploadCache.clear();
  state.editingRoom = editingRoom;
  $('#create-room').textContent = editingRoom ? 'Lưu thay đổi' : 'Tạo phòng & nhận mã →';
  $('#back-editor').textContent = editingRoom ? '← Về phòng' : '← Quay lại';
  setView('editor'); renderEditor();
}
function renderQuestionList() {
  const list = $('#question-list');
  list.innerHTML = state.draft.questions.map((q, i) => `<button type="button" class="question-item ${i === state.selected ? 'selected' : ''}" data-idx="${i}"><strong>${String(i + 1).padStart(2, '0')}</strong><span>${esc(q.q || 'Câu chưa có nội dung')}</span></button>`).join('');
  $('#q-counter').textContent = state.draft.questions.length;
}
function renderOptionsEditor() {
  const q = currentQ();
  $('#options-editor').innerHTML = q.options.map((option, i) => `<div class="option-edit"><span class="opt-number color-${i}">${symbols[i]}</span><input data-option="${i}" maxlength="260" value="${esc(option)}" placeholder="Lựa chọn ${i+1}"/><button class="opt-remove" title="Xóa lựa chọn" data-remove="${i}" type="button" ${q.options.length <= 2 ? 'disabled' : ''}>×</button></div>`).join('');
  const select = $('#correct-option');
  select.innerHTML = q.options.map((o,i) => `<option value="${i}">${i+1}. ${esc(o || 'Lựa chọn ' + (i+1))}</option>`).join('');
  if (!Number.isInteger(q.answer) || q.answer >= q.options.length) q.answer = 0;
  select.value = String(q.answer);
  $('#add-option').disabled = q.options.length >= 8;
}
function validMediaURL(src) {
  return /^https:\/\//i.test(src) || /^\/(?:api\/media\/|media\/)/i.test(src) || /^media\//i.test(src);
}
function fileKey(f) {
  const key = 'local:' + crypto.randomUUID();
  state.files.set(key, f); return key;
}
function resolveMediaForPreview(s) {
  if (state.files.has(s)) return URL.createObjectURL(state.files.get(s));
  if (validMediaURL(s)) return s;
  return '';
}
function isVideo(url, file) {
  return !!(file?.type?.startsWith('video/') || /\.(?:mp4|webm|ogg|ogv)(?:\?.*)?$/i.test(url));
}
function mediaMarkup(src, className = 'question-media', selectedFile = null) {
  const safe = resolveMediaForPreview(src);
  if (!safe) return '';
  if (isVideo(src, selectedFile || state.files.get(src))) {
    return `<video class="${className}" src="${esc(safe)}" controls playsinline preload="metadata"></video>`;
  }
  return `<img class="${className}" src="${esc(safe)}" alt="Media của quiz" loading="lazy"/>`;
}
function renderPreview(slot, value) {
  const el = $(slot);
  if (!value) { el.innerHTML = 'Chưa chọn media'; return; }
  if (state.files.has(value)) {
    const file = state.files.get(value);
    el.innerHTML = `${mediaMarkup(value, 'preview-media', file)}<span>📎 ${esc(file.name)} (${(file.size/1024/1024).toFixed(2)} MB)</span>`;
  } else if (validMediaURL(value)) el.innerHTML = mediaMarkup(value, 'preview-media');
  else el.textContent = 'Nhập URL https:// hoặc chọn file media.';
}
function renderEditor() {
  const q = currentQ(); if (!q) return;
  $('#quiz-title').value = state.draft.title;
  $('#quiz-time').value = state.draft.time;
  renderQuestionList();
  $('#editor-q-heading').textContent = `Câu ${String(state.selected + 1).padStart(2, '0')}`;
  $('#q-text').value = q.q;
  renderOptionsEditor();
  const hidden = !!q.hidden;
  $('#hidden-mode').checked = hidden;
  $('#normal-settings').hidden = hidden;
  $('#hidden-settings').hidden = !hidden;
  $('#explanation').value = q.explanation || '';
  $('#hidden-text').value = q.hidden?.text || '';
  $('#hidden-msg').value = q.hidden?.msg || '';
  $('#media-q').value = q.media || '';
  $('#media-r').value = (hidden ? q.hidden?.media : q.revealMedia) || '';
  $('#q-time').value = q.time || state.draft.time;
  renderPreview('#media-q-preview', q.media);
  renderPreview('#media-r-preview', hidden ? q.hidden?.media : q.revealMedia);
  $('#delete-question').disabled = state.draft.questions.length === 1;
  $('#shuffle-questions').disabled = state.draft.questions.length < 2;
  $('#draft-status').textContent = `${state.draft.questions.length} câu hỏi · Có thể import JSON/CSV hoặc soạn thủ công.`;
}
function bindEditor() {
  $('#go-editor').onclick = () => openEditor();
  $('#go-sample').onclick = async () => {
    try { const r = await fetch('/quiz-mau.json'); if (!r.ok) throw Error('Không đọc được quiz mẫu.');
      openEditor(importDraft(await r.json())); toast('Quiz mẫu đã mở. Bạn có thể chỉnh sửa rồi tạo phòng!');
    } catch(e) { toast(e.message, true); }
  };
  $('#top-home').onclick = () => {
    if (state.view !== 'editor' || !$('#create-room').disabled) setView('home');
  };
  $('#back-editor').onclick = () => {
    if ($('#create-room').disabled) return;
    const room = state.editingRoom;
    if (room) connectRoom(room.code, 'host', room.hostToken);
    else setView('home');
  };
  $('#quiz-title').oninput = e => { state.draft.title = e.target.value; };
  $('#quiz-time').oninput = e => { state.draft.time = Number(e.target.value) || 20; };
  $('#q-text').oninput = e => {
    currentQ().q = e.target.value;
    const label = $(`.question-item[data-idx="${state.selected}"] span`);
    if (label) label.textContent = e.target.value || 'Câu chưa có nội dung';
  };
  $('#options-editor').oninput = e => {
    if (!e.target.matches('input[data-option]')) return;
    const idx = Number(e.target.dataset.option);
    currentQ().options[idx] = e.target.value;
    const opt = $(`#correct-option option[value="${idx}"]`);
    if (opt) opt.textContent = `${idx + 1}. ${e.target.value || 'Lựa chọn '+(idx+1)}`;
  };
  $('#options-editor').onclick = e => {
    const b = e.target.closest('button[data-remove]'); if (!b || currentQ().options.length <= 2) return;
    const idx = Number(b.dataset.remove), q = currentQ(); q.options.splice(idx, 1);
    if (q.answer >= q.options.length) q.answer = q.options.length - 1;
    else if (q.answer > idx) q.answer--;
    renderOptionsEditor();
  };
  $('#question-list').onclick = e => {
    const b = e.target.closest('[data-idx]'); if (!b) return;
    state.selected = Number(b.dataset.idx); renderEditor();
  };
  $('#add-question').onclick = () => {
    if (state.draft.questions.length >= 100) return toast('Tối đa 100 câu hỏi.', true);
    const q = freshQuestion(); q.time = state.draft.time;
    state.draft.questions.push(q); state.selected = state.draft.questions.length - 1; renderEditor();
  };
  $('#delete-question').onclick = () => {
    if (state.draft.questions.length <= 1) return;
    state.draft.questions.splice(state.selected, 1);
    state.selected = Math.max(0, state.selected - 1); renderEditor();
  };
  $('#shuffle-questions').onclick = () => {
    const questions = state.draft.questions;
    if (questions.length < 2) return;
    const previousOrder = questions.slice(), selectedQuestion = currentQ();
    for (let i = questions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [questions[i], questions[j]] = [questions[j], questions[i]];
    }
    if (questions.every((question, i) => question === previousOrder[i])) {
      questions.push(questions.shift());
    }
    state.selected = questions.indexOf(selectedQuestion);
    renderEditor();
    toast('Đã xáo trộn thứ tự câu hỏi.');
  };
  $('#add-option').onclick = () => {
    if (currentQ().options.length < 8) { currentQ().options.push(''); renderOptionsEditor(); }
  };
  $('#hidden-mode').onchange = e => { currentQ().hidden = e.target.checked ? { text: '', msg: '', media: '' } : null; renderEditor(); };
  $('#correct-option').onchange = e => currentQ().answer = Number(e.target.value);
  $('#explanation').oninput = e => currentQ().explanation = e.target.value;
  $('#hidden-text').oninput = e => currentQ().hidden.text = e.target.value;
  $('#hidden-msg').oninput = e => currentQ().hidden.msg = e.target.value;
  $('#q-time').oninput = e => currentQ().time = Number(e.target.value);
  $('#media-q').oninput = e => { currentQ().media = e.target.value.trim(); renderPreview('#media-q-preview', currentQ().media); };
  $('#media-r').oninput = e => {
    const q = currentQ();
    if (q.hidden) { q.hidden.media = e.target.value.trim(); q.revealMedia = ''; }
    else q.revealMedia = e.target.value.trim();
    renderPreview('#media-r-preview', q.hidden ? q.hidden.media : q.revealMedia);
  };
  for (const [inputId, field] of [['media-q-file','q'],['media-r-file','r']]) {
    $('#' + inputId).onchange = e => {
      const f = e.target.files?.[0]; if (!f) return;
      if (f.size > 15 * 1024 * 1024) return toast('Mỗi media tối đa 15 MB.', true);
      const key = fileKey(f), q = currentQ();
      if (field === 'q') q.media = key;
      else if (q.hidden) q.hidden.media = key;
      else q.revealMedia = key;
      renderEditor(); e.target.value = '';
    };
  }
  $('#quiz-import').onchange = onImport;
  $('#create-room').onclick = createRoom;
}
function importDraft(data) {
  if (!data || !Array.isArray(data.questions) || !data.questions.length) throw Error('File cần có mảng questions không rỗng.');
  const time = Number(data.time) || 20;
  return { title: String(data.title || 'Troll Quiz').slice(0, 90), time,
    questions: data.questions.map(raw => ({
      q: String(raw.q ?? raw.question ?? ''), options: Array.isArray(raw.options) ? raw.options.map(String) : ['','','',''],
      answer: raw.answer === undefined || raw.answer === null ? 0 : Number(raw.answer),
      hidden: raw.hidden ? { text:String(raw.hidden.text || ''), msg:String(raw.hidden.msg || ''), media:String(raw.hidden.media || '') } : null,
      media: String(raw.media || ''), revealMedia: String(raw.revealMedia || raw.answerMedia || ''),
      explanation: String(raw.explanation || ''), time: Number(raw.time ?? time)
    })) };
}
function parseCSV(src) {
  const rows = []; let row=[], item='', inQuote=false;
  for (let i=0;i<src.length;i++) {
    const c=src[i];
    if (c === '"') { if (inQuote && src[i+1]==='"') { item+='"'; i++; } else inQuote=!inQuote; }
    else if (c===',' && !inQuote) { row.push(item); item=''; }
    else if ((c==='\n'||c==='\r') && !inQuote) {
      if (c==='\r' && src[i+1]==='\n') i++;
      row.push(item); if (row.some(x=>x.trim())) rows.push(row); row=[]; item='';
    } else item+=c;
  }
  row.push(item); if(row.some(x=>x.trim())) rows.push(row);
  if(rows.length<2) throw Error('CSV cần tiêu đề cột và ít nhất một dòng dữ liệu.');
  const keys=rows.shift().map(x=>x.trim().toLowerCase());
  const data=rows.map(row=>Object.fromEntries(keys.map((key,i)=>[key,(row[i]||'').trim()])));
  return { title:'Quiz nhập từ CSV', time:20, questions:data.map(r=>({
    q: r.q || r.question,
    options: Array.from({length:8}, (_,i)=>r['option'+(i+1)]).filter(Boolean),
    answer: r.hidden_text ? undefined : (Number(r.answer || 1)-1),
    hidden: r.hidden_text ? {text:r.hidden_text,msg:r.hidden_msg || '',media:r.reveal_media || ''} : undefined,
    media:r.media || '', revealMedia:r.reveal_media || '', explanation:r.explanation || '',time:Number(r.time || 20)
  })) };
}
async function onImport(e) {
  const files = [...e.target.files]; if (!files.length) return;
  const main = files.find(x=>/\.(json|csv)$/i.test(x.name));
  if (!main) return toast('Hãy chọn thêm file .json hoặc .csv.', true);
  try {
    const text = await main.text(), imported = /\.csv$/i.test(main.name) ? parseCSV(text.replace(/^\uFEFF/,'')) : JSON.parse(text);
    const draft = importDraft(imported);
    const mediaFiles = new Map(files.filter(f=>f !== main).map(f=>[f.name.toLowerCase(),f]));
    function replaceMedia(path) {
      if (!path || /^(https?:\/\/|local:)/i.test(path)) return path;
      const name=path.replace(/\\/g,'/').split('/').pop().toLowerCase(), file=mediaFiles.get(name);
      return file ? fileKey(file) : path;
    }
    for (const q of draft.questions) {
      q.media=replaceMedia(q.media); q.revealMedia=replaceMedia(q.revealMedia);
      if (q.hidden) q.hidden.media=replaceMedia(q.hidden.media);
    }
    state.draft=draft; state.selected=0; state.pendingRoom=null; state.uploadCache.clear(); renderEditor();
    toast(`Đã nhập ${draft.questions.length} câu hỏi và ${mediaFiles.size} file media.`);
  } catch(err) { toast('Không thể nhập file: ' + err.message, true); }
  e.target.value='';
}
function validateDraft() {
  const draft = state.draft;
  if (!draft.questions.length || draft.questions.length>100) throw Error('Quiz cần 1–100 câu hỏi.');
  for (let i=0;i<draft.questions.length;i++) {
    const q=draft.questions[i];
    if (!q.q.trim()) throw Error(`Câu ${i+1} chưa có nội dung.`);
    if (q.options.length<2 || q.options.length>8 || q.options.some(x=>!x.trim())) throw Error(`Câu ${i+1} cần 2–8 lựa chọn không rỗng.`);
    if (q.hidden && !q.hidden.text.trim()) throw Error(`Câu ${i+1} đang bật đáp án ẩn nhưng chưa nhập đáp án bí mật.`);
    if (!q.hidden && (!Number.isInteger(q.answer) || q.answer<0 || q.answer>=q.options.length)) throw Error(`Câu ${i+1} chưa chọn đáp án đúng.`);
    if (!Number.isFinite(q.time) || q.time<5 || q.time>120) throw Error(`Câu ${i+1}: thời gian cần từ 5 đến 120 giây.`);
    for(const m of [q.media,q.revealMedia,q.hidden?.media]) {
      if (m && !state.files.has(m) && !validMediaURL(m)) throw Error(`Câu ${i+1}: media phải là link HTTPS hoặc file đã chọn (không chấp nhận tên file chưa tải lên).`);
    }
  }
}
async function api(path, data) {
  let r;
  try { r = await fetch(path, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) }); }
  catch { throw Error('Không thể kết nối backend. Hãy chạy npm run dev hoặc kiểm tra mạng.'); }
  let result; try { result = await r.json(); } catch { throw Error('Máy chủ trả về dữ liệu không hợp lệ.'); }
  if (!r.ok) throw Error(result.error || 'Lỗi API ('+r.status+')');
  return result;
}
function strippedQuiz() {
  const copy = structuredClone(state.draft);
  const sanitize = v=>state.files.has(v)?'':v;
  for (const q of copy.questions) {
    q.media = sanitize(q.media); q.revealMedia = sanitize(q.revealMedia);
    if(q.hidden) q.hidden.media=sanitize(q.hidden.media);
  }
  return copy;
}
async function createRoom() {
  try { validateDraft(); } catch(e) { return toast(e.message, true); }
  const editingRoom = state.editingRoom;
  const button = $('#create-room'); button.disabled = true;
  button.textContent = editingRoom ? 'Đang lưu...' : 'Đang tạo phòng...';
  try {
    const quiz = structuredClone(state.draft);
    let room = editingRoom || state.pendingRoom;
    if (!room) {
      room = await api('/api/rooms', { quiz: strippedQuiz(), requireAccount:!!state.account.username });
      state.pendingRoom = room;
      if (room.hostToken) {
        localStorage.setItem('tq-host-'+room.code, room.hostToken);
        localStorage.setItem('tq-room-title-'+room.code, state.draft.title.trim());
      }
    }
    const refs = [...new Set(quiz.questions.flatMap(q=>[q.media,q.revealMedia,q.hidden?.media].filter(s=>state.files.has(s))))];
    if (refs.length) toast(`Đang tải ${refs.length} media lên R2...`);
    for (const ref of refs) {
      if (state.uploadCache.has(ref)) continue;
      const file = state.files.get(ref);
      const r = await fetch('/api/media', { method:'POST', headers:{'Content-Type':file.type,'X-Room-Code':room.code,'X-Host-Token':room.hostToken},body:file });
      const data = await r.json();
      if(!r.ok) throw Error(`Không upload được ${file.name}: ${data.error || r.status}`);
      state.uploadCache.set(ref, data.url);
    }
    function resolved(v) { return state.uploadCache.get(v) || v || ''; }
    for (const q of quiz.questions) {
      q.media=resolved(q.media); q.revealMedia=resolved(q.revealMedia);
      if(q.hidden) q.hidden.media=resolved(q.hidden.media);
    }
    await api(`/api/rooms/${room.code}/quiz`, { hostToken:room.hostToken, quiz });
    if (room.hostToken) localStorage.setItem('tq-room-title-'+room.code, quiz.title.trim());
    state.pendingRoom=null;
    toast(editingRoom ? 'Đã lưu bộ câu hỏi.' : 'Phòng đã sẵn sàng! Chia sẻ mã cho bạn bè nhé.');
    await connectRoom(room.code, 'host', room.hostToken);
  } catch(e) {
    toast(e.message, true);
    $('#draft-status').textContent = state.pendingRoom ? 'Phòng tạm đã tạo; sửa cấu hình media rồi thử lại, không tạo mã mới.' : e.message;
  } finally { button.disabled = false; button.textContent = editingRoom ? 'Lưu thay đổi' : 'Tạo phòng & nhận mã →'; }
}
function roomJoinLink() { return location.origin + location.pathname + '?room=' + encodeURIComponent(state.code); }
async function copyText(value) {
  try { await navigator.clipboard.writeText(value); toast('Đã sao chép!'); }
  catch { prompt('Sao chép nội dung này:', value); }
}
async function connectRoom(code, role, secret) {
  clearInterval(state.poller); clearInterval(state.timer);
  const session = ++state.roomSession;
  state.busy = false;
  state.code=code; state.role=role; state.hostToken=role==='host'?secret:''; state.playerToken=role==='player'?secret:'';
  state.stageKey=''; state.room=null;
  setView('room');
  history.replaceState({}, '', location.pathname + '?room=' + encodeURIComponent(code));
  $('#room-code').textContent=code;
  $('#room-role').textContent=role==='host'?'✳ BẠN LÀ QUẢN TRÒ':'✳ BẠN LÀ NGƯỜI CHƠI';
  $('#stage').innerHTML='<div class="stage-lobby"><h2>Đang kết nối phòng...</h2></div>';
  try { await poll(); }
  catch(e) {
    if (session === state.roomSession) { setView('home'); toast(e.message, true); }
    return;
  }
  if (session !== state.roomSession) return;
  state.poller=setInterval(pollSafe, 2800);
  state.timer=setInterval(updateTimer, 180);
  localStorage.setItem('tq-last-code', code);
}
async function poll() {
  if (state.busy || state.view!=='room') return;
  const session = state.roomSession;
  state.busy=true;
  try {
    const d=await api(`/api/rooms/${state.code}/state`, state.role==='host'?{hostToken:state.hostToken}:{playerToken:state.playerToken});
    if (session !== state.roomSession) return;
    state.room=d; state.serverSkew=d.serverNow-Date.now();
    $('#connection-indicator').textContent='● Đã đồng bộ';
    renderRoom();
  } catch(e) {
    if (session !== state.roomSession) return;
    $('#connection-indicator').textContent='● Mất kết nối, đang thử lại...'; throw e;
  }
  finally { if (session === state.roomSession) state.busy=false; }
}
async function pollSafe() { try { await poll(); } catch(e) { console.warn(e.message); } }
function timerLeft() { const d=state.room; return d && d.phase==='question' ? Math.max(0, d.deadline-(Date.now()+state.serverSkew)) : 0; }
function updateTimer() {
  const d=state.room, bar=$('#timer-value'), label=$('#timer-label');
  if (!d || d.phase!=='question'||!bar) return;
  const ms=timerLeft(), total=(d.question?.time || 20)*1000;
  bar.style.width=Math.max(0,100*ms/total)+'%';
  if(label) label.textContent=Math.ceil(ms/1000)+'s';
  const points=$('#available-points');
  if(points) points.textContent=ms>0 ? Math.round(500+500*Math.min(1,ms/total)).toLocaleString('vi-VN')+'đ nếu đúng' : 'Hết giờ';
}
function phaseName(phase) { return ({lobby:'SẢNH CHỜ',question:'ĐANG CHƠI',reveal:'CÔNG BỐ',ended:'KẾT THÚC'})[phase] || '...'; }
function renderRoom() {
  const d=state.room; if(!d) return;
  $('#room-title').textContent=d.title;
  $('#room-code').textContent=d.code;
  $('#phase-badge').textContent=phaseName(d.phase);
  $('#room-hint').textContent=({ lobby:'Mời bạn bè vào phòng rồi bắt đầu!', question:`Câu ${d.index+1}/${d.total} · Đã chốt ${d.submitted}/${d.count} người`, reveal:`Câu ${d.index+1}/${d.total} · Đáp án đã được công bố!`, ended:'Cùng xem kết quả chung cuộc!' })[d.phase];
  $('#player-count').textContent=d.count+' người';
  const key=[d.phase,d.index,d.me?.answer?.choice ?? 'none',d.host?'host':'player'].join(':');
  if(state.stageKey!==key) { state.stageKey=key; renderStage(d); }
  renderRanking(d);
  renderHostActions(d);
  updateTimer();
}
function renderRanking(d) {
  $('#rankings').innerHTML=d.leaderboard.length?d.leaderboard.map((p,i)=>`<div class="rank-row ${d.me?.id===p.id?'is-me':''}"><span class="rank-order">${i===0?'🥇':i===1?'🥈':i===2?'🥉':p.rank}</span><span class="rank-avatar">${esc((p.name||'?')[0].toUpperCase())}</span><span class="rank-name" title="${esc(p.name)}">${esc(p.name)}${d.me?.id===p.id?' (bạn)':''}</span><span class="rank-score">${p.score.toLocaleString('vi-VN')}đ</span></div>`).join(''):'<div class="empty-rank">Chưa ai vào phòng.<br/>Hãy chia sẻ mã và bắt đầu!</div>';
}
function renderStage(d) {
  const stage=$('#stage');
  if(d.phase==='lobby') {
    stage.innerHTML=`<div class="stage-lobby"><div class="stage-big-icon">🎲</div><h2>${d.host?'Chuẩn bị bùng nổ!':'Bạn đã vào phòng!'}</h2><p>${d.host?'Chia sẻ mã phòng cho bạn bè. Khi mọi người vào đủ, hãy nhấn Bắt đầu.':'Chờ quản trò bắt đầu quiz. Đừng quên để ý đáp án đặc biệt nhé!'}</p><div class="invite-code">${esc(d.code)}</div><p>Đã có <strong>${d.count}</strong> người chơi tham gia.</p></div>`;
    return;
  }
  if(d.phase==='ended') {
    const champion=d.leaderboard[0];
    stage.innerHTML=`<div class="stage-end"><div class="trophy">🏆</div><h2>Game over. Vui hết nấc!</h2><p>Trận đấu đã kết thúc — cùng chúc mừng ngôi vương của hôm nay.</p><div class="winner">${champion?esc(champion.name)+' — '+champion.score.toLocaleString('vi-VN')+'đ':'Chưa có người chơi'}</div>${d.me?`<div class="feedback-box"><strong>Điểm của bạn: ${d.me.score.toLocaleString('vi-VN')}đ</strong></div>`:''}</div>`;
    return;
  }
  const q=d.question, reveal=d.phase==='reveal', solution=q.solution, answer=d.me?.answer;
  const shownMedia=reveal?(solution?.media || q.media):q.media;
  const options=q.options.map((option,i)=>{
    const selected=answer?.choice===i, right=reveal && solution?.type==='normal' && solution.answer===i;
    const bad=reveal && selected && !right;
    return `<button type="button" data-choice="${i}" class="answer-choice color-${i}${selected?' selected':''}${right?' correct-choice':''}${bad?' incorrect-choice':''}" ${d.host||reveal||answer?'disabled':''}><span class="shape">${symbols[i]}</span><span>${esc(option)}</span></button>`;
  }).join('');
  let feedback='';
  if(reveal) {
    const text=solution.type==='hidden'?`🕵️ ĐÁP ÁN ẨN: ${solution.text}`:`✅ ĐÁP ÁN ĐÚNG: ${solution.text}`;
    const own=solution.type==='hidden'?'<p>Không ai ghi điểm câu này.</p>':answer?`<p>${answer.correct?'🎉 Bạn trả lời đúng! +'+answer.points+' điểm':'😼 Tiếc rồi, bạn chưa ghi điểm câu này.'}</p>`:(d.host?'':'<p>Bạn không trả lời câu này.</p>');
    feedback=`<div class="feedback-box"><strong>${esc(text)}</strong>${solution.explanation?`<p>${esc(solution.explanation)}</p>`:''}${own}</div>`;
  } else if(answer) feedback='<div class="waiting-hint">✅ Đã chốt lựa chọn! Đáp án sẽ hiện khi hết giờ.</div>';
  else if(d.host) feedback='<div class="waiting-hint">Bạn là quản trò — mọi người đang chọn đáp án.</div>';
  else feedback='<div class="waiting-hint">Chọn một đáp án.</div>';
  stage.innerHTML=`<div class="stage-header"><span>✦ CÂU ${d.index+1} / ${d.total}</span>${!reveal&&!answer?'<span id="available-points"></span>':''}<span id="timer-label">${q.time}s</span></div>
    <div class="timer-track"><div id="timer-value"></div></div>
    ${mediaMarkup(shownMedia, reveal?'reveal-media':'question-media')}
    <h2 class="question-text">${esc(q.q)}</h2>
    <div class="answer-grid">${options}</div>
    ${feedback}`;
  if(!d.host && !reveal && !answer) {
    $$('[data-choice]',stage).forEach(btn=>btn.onclick=()=>submitAnswer(Number(btn.dataset.choice)));
  }
  if(reveal) $('#timer-label').textContent='ĐÃ CÔNG BỐ';
}
function renderHostActions(d) {
  const container=$('#host-actions');
  container.hidden=!d.host;
  if(!d.host) return;
  let label='',button='',act='';
  if(d.phase==='lobby') {label='Đang ở sảnh chờ';button='▶ Bắt đầu quiz';act='start';}
  else if(d.phase==='question') {label=`Đã trả lời ${d.submitted}/${d.count} người · Đáp án sẽ hiện khi hết giờ`;}
  else if(d.phase==='reveal') {label=`Đã công bố câu ${d.index+1}`;button=d.index+1>=d.total?'🏁 Kết thúc':'Câu tiếp theo →';act='next';}
  else {label='Đã kết thúc trận';button='↺ Chơi lại';act='reset';}
  const editButton = d.phase === 'lobby' ? '<button class="button subtle" type="button" id="host-edit-quiz">Sửa bộ câu hỏi</button>' : '';
  const endButton = d.phase !== 'ended' && !(d.phase === 'reveal' && d.index + 1 >= d.total)
    ? '<button class="button subtle" type="button" id="host-end-room">Kết thúc ngay</button>' : '';
  container.innerHTML=`<div><strong>🎛 Bảng điều khiển quản trò</strong><p>${esc(label)}</p></div>${editButton}${endButton}${act?`<button class="button primary" type="button" id="host-main-action">${button}</button>`:''}`;
  if(state.hostActionPending === state.roomSession) $$('button',container).forEach(button=>button.disabled=true);
  if(act) $('#host-main-action').onclick=()=>hostAction(act);
  if(editButton) $('#host-edit-quiz').onclick=()=>openEditor(importDraft(d.hostQuiz), {code:d.code, hostToken:state.hostToken});
  if(endButton) $('#host-end-room').onclick=()=>{
    if(window.confirm('Kết thúc phòng ngay cho tất cả người chơi? Điểm hiện tại sẽ được giữ lại.')) hostAction('end');
  };
}
async function hostAction(action) {
  const session=state.roomSession;
  if(state.hostActionPending === session) return;
  state.hostActionPending=session;
  renderHostActions(state.room);
  try {
    await api(`/api/rooms/${state.code}/action`,{hostToken:state.hostToken,action});
    if(session !== state.roomSession) return;
    state.stageKey='';
    await poll();
  } catch(e) {
    if(session === state.roomSession) toast(e.message,true);
  } finally {
    if(state.hostActionPending === session) state.hostActionPending=null;
    if(session === state.roomSession) renderHostActions(state.room);
  }
}
async function submitAnswer(choice) {
  if(state.role!=='player' || state.room?.phase!=='question' || state.room?.me?.answer || timerLeft()<=0) return;
  $$('.answer-choice', $('#stage')).forEach(b=>b.disabled=true);
  try {
    await api(`/api/rooms/${state.code}/answer`,{playerToken:state.playerToken,choice});
    // Cho phản hồi tức thời, máy chủ vẫn tự tính điểm và xác minh đáp án.
    state.room.me.answer={choice, correct:false, points:0}; state.stageKey=''; renderStage(state.room);
    await poll();
  } catch(e) {toast(e.message,true);state.stageKey='';await pollSafe();}
}
function initRoom() {
  $('#account-form').onsubmit=async e=>{
    e.preventDefault();
    const form=e.currentTarget;
    const action=e.submitter?.value || 'login';
    const username=$('#account-username').value.trim().toLowerCase();
    const password=$('#account-password');
    const buttons=$$('button',form);
    buttons.forEach(button=>button.disabled=true);
    try {
      const credential=await accountCredential(username,password.value);
      await api('/api/account/'+action,{username,credential});
      form.reset();
      await refreshAccount();
    } catch(error) { toast(error.message,true); }
    finally { buttons.forEach(button=>button.disabled=false); }
  };
  $('#account-logout').onclick=async e=>{
    const button=e.currentTarget;
    button.disabled=true;
    try {
      await api('/api/account/logout',{});
      state.account={username:null,rooms:[]};
      renderSavedRooms();
    } catch(error) { toast(error.message,true); }
    finally { button.disabled=false; }
  };
  $('#saved-room-list').onclick=async e=>{
    const claim=e.target.closest('[data-claim-room]');
    if (claim) {
      const code=claim.dataset.claimRoom;
      claim.disabled=true;
      try {
        await api('/api/account/claim',{code,hostToken:localStorage.getItem('tq-host-'+code)});
        localStorage.removeItem('tq-host-'+code);
        localStorage.removeItem('tq-room-title-'+code);
        await refreshAccount();
        toast('Đã lưu phòng vào tài khoản.');
      } catch(error) { toast(error.message,true); }
      finally { claim.disabled=false; }
      return;
    }
    const button=e.target.closest('[data-open-room]');
    if(!button) return;
    const code=button.dataset.openRoom;
    const host=localStorage.getItem('tq-host-'+code);
    if(state.account.rooms.some(room=>room.code===code)) connectRoom(code,'host','');
    else if(host) connectRoom(code,'host',host);
    else renderSavedRooms();
  };
  $('#copy-code').onclick=()=>copyText(state.code);
  $('#copy-link').onclick=()=>copyText(roomJoinLink());
  $('#room-exit').onclick=()=>setView('home');
  $('#join-code').oninput=e=>e.target.value=e.target.value.toUpperCase().replace(/[^A-Z2-9]/g,'').slice(0,6);
  $('#join-form').onsubmit=async e=>{
    e.preventDefault();
    const name=$('#join-name').value.trim(),code=$('#join-code').value.trim().toUpperCase();
    if(!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) return toast('Mã phòng gồm 6 ký tự (không dùng I, O, 0, 1).',true);
    const button=$('#join-form button[type="submit"]'); button.disabled=true;
    try {
      const old=localStorage.getItem('tq-player-'+code);
      const result=await api(`/api/rooms/${code}/join`,{name,playerToken:old||undefined});
      localStorage.setItem('tq-player-'+code,result.playerToken);
      await connectRoom(code,'player',result.playerToken);
    } catch(err) {toast(err.message,true);}
    finally{button.disabled=false;}
  };
}
async function boot() {
  bindEditor(); initRoom();
  renderSavedRooms();
  try { await refreshAccount(); } catch(e) { console.warn(e.message); }
  const params=new URLSearchParams(location.search);
  const code=(params.get('room')||'').toUpperCase();
  if(/^[A-HJ-NP-Z2-9]{6}$/.test(code)) {
    $('#join-code').value=code;
    const host=localStorage.getItem('tq-host-'+code),player=localStorage.getItem('tq-player-'+code);
    if(state.account.rooms.some(room=>room.code===code)) await connectRoom(code,'host','');
    else if(host) await connectRoom(code,'host',host);
    else if(player) await connectRoom(code,'player',player);
    else {$('#join-code').focus(); toast('Đã điền mã phòng. Nhập tên để tham gia!');}
  }
}
boot();
