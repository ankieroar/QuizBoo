import {setupSounds, setupStageZoom} from './room-effects.js?v=mobile-controls';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const storage = (() => {
  const memory=new Map();
  return {
    getItem(key) {
      if (memory.has(key)) return memory.get(key);
      try { return localStorage.getItem(key); } catch { return null; }
    },
    setItem(key,value) {
      try { localStorage.setItem(key,value); memory.delete(key); }
      catch { memory.set(key,value); }
    },
    removeItem(key) {
      try { localStorage.removeItem(key); memory.delete(key); }
      catch { memory.set(key,null); }
    },
    keys() {
      let keys=[];
      try { keys=Object.keys(localStorage); } catch {}
      return [...new Set([...keys,...memory.keys()])].filter(key=>memory.get(key)!==null);
    }
  };
})();
const state = {
  view: 'home', draft: null, selected: 0, files: new Map(), pendingRoom: null, editingRoom: null,
  role: null, code: '', hostToken: '', playerToken: '', room: null,
  timer: null, phaseTimer:null, poller: null, busy: false, pollQueued: false, roomSession: 0, stageKey: '', serverSkew: 0,
  uploadCache: new Map(), account: { username:null, rooms:[] }, hostActionPending:null,
  finalRanking:[], showFinalRanking:true, rankRows:new Map(), pendingAnswer:null
};
const sound = setupSounds($('#sound-toggle'));
const resetStageZoom = setupStageZoom($('#stage-viewport'), $('#stage'), $('#zoom-controls'));
const symbols = 'ABCDEFGH';
const quizText = value => esc(String(value ?? '').normalize('NFC'));
const MAX_MEDIA_BYTES = 150 * 1024 * 1024;
const SINGLE_UPLOAD_BYTES = 15 * 1024 * 1024;
const mediaTypes = {png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',mp4:'video/mp4',webm:'video/webm',ogg:'video/ogg',ogv:'video/ogg'};
function fileMediaType(file) {
  if (!file) return '';
  if (Object.values(mediaTypes).includes(file.type)) return file.type;
  return mediaTypes[file.name.split('.').pop().toLowerCase()] || file.type || 'application/octet-stream';
}
let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast'); el.textContent = message; el.classList.toggle('error', isError); el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.hidden = true, 4800);
}
function setView(view) {
  for (const id of ['home','editor','room']) $('#' + id).hidden = id !== view;
  const previousView = state.view;
  if (previousView === 'room' && view !== 'room') {
    notifyPlayerLeft();
    sound.stop();
    $('#stage video')?.pause();
    resetStageZoom();
  }
  state.view = view;
  if (view === 'home' && (previousView === 'room' || state.editingRoom)) history.replaceState({}, '', location.pathname);
  if (view === 'home') {
    renderSavedRooms();
    refreshAccount().catch(e=>toast(e.message,true));
  }
  $('#top-home').hidden = view === 'home';
  if (view !== 'room') {
    clearInterval(state.poller); clearInterval(state.timer); clearTimeout(state.phaseTimer); state.poller = null;
    state.roomSession++; state.busy = false;
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function notifyPlayerLeft() {
  if (state.view !== 'room' || state.role !== 'player' || !state.playerToken) return;
  fetch(`/api/rooms/${state.code}/leave`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({playerToken:state.playerToken}),
    keepalive:true
  }).catch(()=>{});
}
function renderSavedRooms() {
  const list = $('#saved-room-list');
  const owned = new Set(state.account.rooms.map(room=>room.code));
  const localRooms = storage.keys()
    .filter(key => /^tq-host-[A-HJ-NP-Z2-9]{6}$/.test(key) && storage.getItem(key))
    .map(key => {
      const code = key.slice('tq-host-'.length);
      return { code, title: storage.getItem('tq-room-title-'+code) };
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
  return !!(fileMediaType(file).startsWith('video/') || /\.(?:mp4|webm|ogg|ogv)(?:\?.*)?$/i.test(url));
}
function mediaMarkup(src, className = 'question-media', selectedFile = null, eager = false) {
  const safe = resolveMediaForPreview(src);
  if (!safe) return '';
  if (isVideo(src, selectedFile || state.files.get(src))) {
    const stageVideo=className==='question-media' || className==='reveal-media';
    return `<video class="${className}" src="${esc(safe)}" controls playsinline preload="metadata"${stageVideo?' muted':''}></video>`;
  }
  return `<img class="${className}" src="${esc(safe)}" alt="Media của quiz" loading="${eager?'eager':'lazy'}"/>`;
}
function startStageVideo() {
  const video=$('#stage video');
  if (!video) return;
  video.muted=true;
  video.autoplay=true;
  $('#stage-video-sound').hidden=false;
  video.play().catch(()=>{ /* Native controls remain available if autoplay is blocked. */ });
}
function bindVideoSound(stage) {
  const video=$('video',stage);
  if (!video) return;
  const button=$('#stage-video-sound');
  const update=()=>{
    if (!video.isConnected) return;
    setText(button,video.muted?'Bật tiếng video':'Tắt tiếng video');
    button.setAttribute('aria-pressed',String(!video.muted));
  };
  const toggle=()=>{
    video.muted=!video.muted;
    if (!video.muted && video.paused) video.play().catch(()=>{});
    update();
  };
  let touchStart, lastTap=-Infinity;
  button.ontouchstart=event=>{touchStart=event.touches.length===1 ? event.touches[0] : null;};
  button.ontouchend=event=>{
    const end=event.changedTouches[0];
    if (!touchStart || !end || event.touches.length ||
        Math.hypot(end.clientX-touchStart.clientX,end.clientY-touchStart.clientY)>12) return;
    if (event.cancelable) event.preventDefault();
    lastTap=performance.now();
    toggle();
  };
  button.onclick=event=>{
    if (event.detail===0 || performance.now()-lastTap>450) toggle();
  };
  video.addEventListener('volumechange',update);
  update();
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
      if (f.size > MAX_MEDIA_BYTES) return toast('Mỗi media tối đa 150 MB.', true);
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
    const bytes = new Uint8Array(await main.arrayBuffer());
    const encoding = bytes[0]===0xff && bytes[1]===0xfe ? 'utf-16le'
      : bytes[0]===0xfe && bytes[1]===0xff ? 'utf-16be' : 'utf-8';
    let text;
    try { text = new TextDecoder(encoding,{fatal:true}).decode(bytes); }
    catch { throw Error('File sai mã hóa. Hãy lưu lại dưới dạng CSV UTF-8 hoặc JSON UTF-8.'); }
    const imported = /\.csv$/i.test(main.name) ? parseCSV(text) : JSON.parse(text);
    const draft = importDraft(imported);
    const mediaFiles = new Map(files.filter(f=>f !== main).map(f=>[f.name.toLowerCase(),f]));
    function replaceMedia(path) {
      if (!path || /^(https?:\/\/|local:)/i.test(path)) return path;
      const name=path.replace(/\\/g,'/').split('/').pop().toLowerCase(), file=mediaFiles.get(name);
      if (file?.size > MAX_MEDIA_BYTES) throw Error(`${file.name} vượt 150 MB.`);
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
  if (!r.ok) throw Object.assign(Error(result.error || 'Lỗi API ('+r.status+')'), {code:result.code});
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
async function sendMedia(path, headers, body, attempts = 1) {
  for (let attempt = 1; ; attempt++) {
    let response;
    try { response = await fetch(path,{method:'POST',headers,body}); }
    catch (e) { if (attempt>=attempts) throw e; }
    if (response) {
      const data = await response.json().catch(()=>null);
      if (response.ok && data) return data;
      const retryable = response.status===408 || response.status===429 || response.status>=500;
      if (!retryable || attempt>=attempts) throw Error(data?.error || `HTTP ${response.status}`);
    }
    await new Promise(resolve=>setTimeout(resolve,500*2**(attempt-1)));
  }
}
async function uploadMedia(file, room) {
  const type = fileMediaType(file);
  const headers = {'X-Room-Code':room.code,'X-Host-Token':room.hostToken};
  if (file.size<=SINGLE_UPLOAD_BYTES) {
    return sendMedia('/api/media',{...headers,'Content-Type':type},file);
  }
  const base = '/api/media/multipart/';
  const jsonHeaders = {...headers,'Content-Type':'application/json'};
  const {session,partBytes} = await sendMedia(base+'start',jsonHeaders,JSON.stringify({size:file.size,type}));
  const sessionHeaders = {...headers,'X-Media-Upload':session};
  const parts = new Array(Math.ceil(file.size/partBytes));
  let next = 0, uploaded = 0, failure;
  async function sendParts() {
    while (!failure && next<parts.length) {
      const index = next++;
      const chunk = file.slice(index*partBytes,(index+1)*partBytes);
      try {
        parts[index] = await sendMedia(base+'part',{...sessionHeaders,'X-Media-Part':String(index+1)},chunk,4);
        uploaded += chunk.size;
        $('#draft-status').textContent = `Đang tải ${file.name} · ${Math.floor(uploaded/file.size*100)}%`;
      } catch (e) { failure = e; }
    }
  }
  try {
    await Promise.all([sendParts(),sendParts()]);
    if (failure) throw failure;
    return await sendMedia(base+'complete',{...sessionHeaders,'Content-Type':'application/json'},JSON.stringify({parts}),4);
  } catch (e) {
    sendMedia(base+'abort',sessionHeaders,null).catch(()=>{});
    throw e;
  }
}
async function createRoom() {
  try { validateDraft(); } catch(e) { return toast(e.message, true); }
  const editingRoom = state.editingRoom;
  const button = $('#create-room'); button.disabled = true;
  button.textContent = editingRoom ? 'Đang lưu...' : 'Đang tạo phòng...';
  try {
    const quiz = structuredClone(state.draft);
    const refs = [...new Set(quiz.questions.flatMap(q=>[q.media,q.revealMedia,q.hidden?.media].filter(s=>state.files.has(s))))];
    if (refs.some(ref=>!state.uploadCache.has(ref))) {
      const response = await fetch('/api/health', {cache:'no-store'});
      if (!response.ok) throw Error('Không kiểm tra được kết nối R2.');
      if (!(await response.json()).r2) throw Error('Máy chủ chưa kết nối R2. Cần cấu hình binding MEDIA để tải file.');
    }
    let room = editingRoom || state.pendingRoom;
    if (!room) {
      room = await api('/api/rooms', { quiz: strippedQuiz(), requireAccount:!!state.account.username });
      state.pendingRoom = room;
      if (room.hostToken) {
        storage.setItem('tq-host-'+room.code, room.hostToken);
        storage.setItem('tq-room-title-'+room.code, state.draft.title.trim());
      }
    }
    if (refs.length) toast(`Đang tải ${refs.length} media lên R2...`);
    for (const ref of refs) {
      if (state.uploadCache.has(ref)) continue;
      const file = state.files.get(ref);
      $('#draft-status').textContent = `Đang tải ${file.name}…`;
      try {
        const data = await uploadMedia(file, room);
        if (!data?.url) throw Error('Máy chủ chưa trả về địa chỉ file.');
        state.uploadCache.set(ref, data.url);
      } catch (e) { throw Error(`Không tải được ${file.name}: ${e.message}`); }
    }
    function resolved(v) { return state.uploadCache.get(v) || v || ''; }
    for (const q of quiz.questions) {
      q.media=resolved(q.media); q.revealMedia=resolved(q.revealMedia);
      if(q.hidden) q.hidden.media=resolved(q.hidden.media);
    }
    await api(`/api/rooms/${room.code}/quiz`, { hostToken:room.hostToken, quiz });
    if (room.hostToken) storage.setItem('tq-room-title-'+room.code, quiz.title.trim());
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
  clearTimeout(state.phaseTimer);
  resetStageZoom();
  const session = ++state.roomSession;
  state.busy = false;
  state.pollQueued = false;
  state.code=code; state.role=role; state.hostToken=role==='host'?secret:''; state.playerToken=role==='player'?secret:'';
  state.stageKey=''; state.room=null;
  state.finalRanking=[];
  state.showFinalRanking=true;
  for (const {row} of state.rankRows.values()) row.remove();
  state.rankRows.clear();
  state.pendingAnswer=null;
  $('#ranking-panel').hidden=true;
  $('#stage-video-sound').hidden=true;
  $('#host-actions').hidden=true;
  setView('room');
  history.replaceState({}, '', location.pathname + '?room=' + encodeURIComponent(code));
  $('#room-code').textContent=code;
  $('#room-role').textContent=role==='host'?'✳ BẠN LÀ QUẢN TRÒ':'✳ BẠN LÀ NGƯỜI CHƠI';
  $('#stage').innerHTML='<div class="stage-lobby"><h2>Đang kết nối phòng...</h2></div>';
  try { await poll(); }
  catch(e) {
    if (session === state.roomSession) {
      if (e.code === 'PLAYER_KICKED') $('#join-code').value=code;
      setView('home');
      toast(e.message, true);
    }
    return;
  }
  if (session !== state.roomSession) return;
  state.poller=setInterval(pollSafe, 2800);
  state.timer=setInterval(updateTimer, 180);
  storage.setItem('tq-last-code', code);
}
async function poll(refreshAfterPending = false) {
  if (state.view!=='room') return;
  if (state.busy) {
    if (refreshAfterPending) state.pollQueued=true;
    return;
  }
  const session = state.roomSession;
  state.busy=true;
  try {
    const sentAt=performance.now();
    const d=await api(`/api/rooms/${state.code}/state`, state.role==='host'?{hostToken:state.hostToken}:{playerToken:state.playerToken});
    const receivedAt=performance.now();
    if (session !== state.roomSession) return;
    const previous = state.room;
    if (d.phase==='question' && previous?.phase==='question' && d.index===previous.index &&
        d.deadline===previous.deadline && d.me && !d.me.answer && previous.me?.answer) {
      d.me.answer=previous.me.answer;
    }
    if (d.phase==='ended' && previous?.phase!=='ended') {
      state.finalRanking=d.leaderboard;
      state.showFinalRanking=true;
    }
    state.room=d;
    const serverReceivedAt=d.serverReceivedAt ?? d.serverNow;
    state.serverSkew=(serverReceivedAt+d.serverNow-sentAt-receivedAt)/2;
    $('#connection-indicator').textContent='● Đã đồng bộ';
    renderRoom();
    schedulePhaseBoundary(d);
    playRoomResult(previous, d);
  } catch(e) {
    if (session !== state.roomSession) return;
    if (e.code === 'PLAYER_KICKED') {
      $('#join-code').value=state.code;
      setView('home');
      toast(e.message,true);
      return;
    }
    $('#connection-indicator').textContent='● Mất kết nối, đang thử lại...'; throw e;
  }
  finally {
    if (session === state.roomSession) {
      state.busy=false;
      if (state.pollQueued) {
        state.pollQueued=false;
        pollSafe();
      }
    }
  }
}
async function pollSafe() { try { await poll(); } catch(e) { console.warn(e.message); } }
function playRoomResult(previous, room) {
  if (!previous || document.hidden) return;
  if (room.phase==='reveal' && (previous.phase!=='reveal' || previous.index!==room.index)) {
    if (room.me?.answer?.correct) sound.play('correct','celebrate');
    else if (room.me?.answer) sound.play('wrong');
    else if (room.host) sound.play('celebrate');
  }
  const champion=state.finalRanking[0];
  if (room.phase==='ended' && previous.phase!=='ended' && champion) {
    sound.play(room.host || room.me?.id===champion.id ? 'victory' : 'defeat');
  }
}
function serverClock() { return performance.now()+state.serverSkew; }
function timerLeft(now = serverClock()) {
  const d=state.room;
  return d?.phase==='question' ? Math.max(0,d.deadline-now) : 0;
}
function schedulePhaseBoundary(d) {
  clearTimeout(state.phaseTimer);
  const boundary=d.phase==='question' ? d.startsAt : d.resultsUntil;
  const delay=boundary-serverClock();
  if (delay>0) state.phaseTimer=setTimeout(updateTimer,Math.ceil(delay));
}
function updateHostTiming(d, now) {
  if (!d.host) return;
  const pending=state.hostActionPending===state.roomSession;
  const close=$('#host-close-question');
  if (close) close.disabled=pending || now<d.startsAt || now>=d.deadline;
  const next=$('#host-main-action');
  if (d.phase==='reveal' && next) next.disabled=pending || now<d.resultsUntil;
  if (d.phase==='question' && next) next.disabled=pending || now>=d.deadline;
}
function updateTimer() {
  const d=state.room;
  if (document.hidden || !d || state.view!=='room') return;
  const now=serverClock();
  updateHostTiming(d,now);
  if (d.phase==='reveal') {
    const hold=Math.max(0,Math.ceil((d.resultsUntil-now)/1000));
    setText($('#results-clock'),hold ? `Xem bảng điểm · ${hold} giây` : d.host ? '' : 'Chờ quản trò tiếp tục');
    return;
  }
  if (d.phase!=='question') return;
  const countdown=$('#question-countdown');
  if (!countdown.hidden) {
    const remaining=d.startsAt-now;
    if (remaining>0) {
      setText($('#countdown-number'),String(Math.min(3,Math.ceil(remaining/1000))));
      setText($('#phase-badge'),'CHUẨN BỊ');
      return;
    }
    countdown.hidden=true;
    const content=$('#question-content');
    content.inert=false;
    content.classList.replace('is-preparing','is-opening');
    startStageVideo();
    setText($('#phase-badge'),phaseName(d.phase));
    if (!d.host) renderActiveAnswer(d);
  }
  const ms=timerLeft(now), total=(d.question?.time || 20)*1000;
  if (!ms && !$('#question-content').classList.contains('is-closed')) {
    $('#question-content').classList.add('is-closed');
    if (!d.host) renderActiveAnswer(d);
  }
  $('#timer-value').style.width=Math.min(100,100*ms/total)+'%';
  setText($('#timer-label'),Math.ceil(ms/1000)+'s');
  const points=$('#available-points');
  if(points && !points.hidden) setText(points,ms>0 ? Math.round(500+500*Math.min(1,ms/total)).toLocaleString('vi-VN')+'đ nếu đúng' : 'Hết giờ');
}
function phaseName(phase) { return ({lobby:'SẢNH CHỜ',question:'ĐANG CHƠI',reveal:'CÔNG BỐ',ended:'KẾT THÚC'})[phase] || '...'; }
function renderRoom() {
  const d=state.room; if(!d) return;
  $('#room').dataset.phase=d.phase;
  setText($('#room-title'),d.title.normalize('NFC'));
  setText($('#room-code'),d.code);
  setText($('#phase-badge'),d.phase==='question' && serverClock()<d.startsAt ? 'CHUẨN BỊ' : phaseName(d.phase));
  setText($('#room-hint'),({ lobby:'Mời bạn bè vào phòng rồi bắt đầu!', question:`Câu ${d.index+1}/${d.total} · Đã chốt ${d.submitted}/${d.count} người`, reveal:`Câu ${d.index+1}/${d.total} · Đáp án đã được công bố!`, ended:'Cùng xem kết quả chung cuộc!' })[d.phase]);
  const key=[d.phase,d.index,d.deadline,d.host?'host':'player',
    d.phase==='lobby' ? d.count : ''].join(':');
  if(state.stageKey!==key) { state.stageKey=key; renderStage(d); }
  if (d.phase==='question' && !d.host) renderActiveAnswer(d);
  renderRanking(d);
  renderHostActions(d);
  updateTimer();
}
function renderRanking(d) {
  const ended=d.phase==='ended';
  const final=ended && state.showFinalRanking;
  $('#ranking-panel').hidden=false;
  $('#final-actions').hidden=!final;
  $('#room-exit').hidden=final;
  $('#show-final-ranking').hidden=!ended || final;
  const players=final ? state.finalRanking : d.leaderboard;
  setText($('#ranking-title'),final ? 'Xếp hạng chung cuộc' : d.phase==='reveal' ? `Bảng điểm sau câu ${d.index+1}` : 'Bảng xếp hạng');
  setText($('#player-count'),final ? `${players.length} người` : `${d.count} online`);
  const list=$('#rankings');
  const rows=state.rankRows;
  const current=[...list.children].filter(row=>row.classList.contains('rank-row'));
  const reordered=current.length!==players.length || players.some((p,i)=>rows.get(p.id)?.row!==current[i]);
  const before=new Map();
  let bounds;
  if (reordered && current.length && typeof Element.prototype.animate==='function' &&
      !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    bounds=list.getBoundingClientRect();
    for (const row of current) {
      const rect=row.getBoundingClientRect();
      if (rect.bottom>bounds.top && rect.top<bounds.bottom) before.set(row,rect.top);
    }
    for (const entry of rows.values()) entry.motion?.cancel();
  }

  const ids=new Set(players.map(p=>p.id));
  for (const [id,entry] of rows) {
    if (!ids.has(id)) { entry.row.remove(); rows.delete(id); }
  }
  $('#empty-ranking').hidden=players.length!==0;
  const canKick=d.host && !final;
  const actionPending=state.hostActionPending===state.roomSession;
  let cursor=$('#empty-ranking').nextSibling;
  for (const p of players) {
    const entry=rows.get(p.id) || makeRankRow(rows,p.id);
    const mine=d.me?.id===p.id;
    if (entry.player!==p.name || entry.mine!==mine) {
      const name=p.name.normalize('NFC');
      setText(entry.avatar,Array.from(name)[0]?.toUpperCase() || '?');
      setText(entry.name,name+(mine?' (bạn)':''));
      entry.name.title=name;
      entry.kick.setAttribute('aria-label',`Mời ${name} ra khỏi phòng`);
      entry.row.classList.toggle('is-me',mine);
      entry.player=p.name;
      entry.mine=mine;
    }
    if (p.rank!==entry.position) {
      setText(entry.rank,['🥇','🥈','🥉'][p.rank-1] ?? String(p.rank));
      entry.position=p.rank;
    }
    if (p.score!==entry.points) {
      setText(entry.score,`${p.score.toLocaleString('vi-VN')}đ`);
      entry.points=p.score;
    }
    if (entry.kick.hidden===canKick) entry.kick.hidden=!canKick;
    if (entry.kick.disabled!==actionPending) entry.kick.disabled=actionPending;
    if (reordered) {
      if (entry.row!==cursor) list.insertBefore(entry.row,cursor);
      cursor=entry.row.nextSibling;
    }
  }
  if (!before.size) return;
  const moves=[];
  for (const entry of rows.values()) {
    if (!before.has(entry.row)) continue;
    const rect=entry.row.getBoundingClientRect();
    const offset=before.get(entry.row)-rect.top;
    if (Math.abs(offset)>1 && rect.bottom>bounds.top && rect.top<bounds.bottom) moves.push([entry,offset]);
  }
  for (const [entry,offset] of moves) {
    entry.motion=entry.row.animate([{transform:`translateY(${offset}px)`},{transform:'translateY(0)'}],
      {duration:480,easing:'cubic-bezier(.2,.75,.25,1)'});
  }
}
function setText(element, value) {
  if (element.textContent!==value) element.textContent=value;
}
function makeRankRow(rows, id) {
  const row=document.createElement('div');
  row.className='rank-row';
  row.innerHTML='<span class="rank-order"></span><span class="rank-avatar" aria-hidden="true"></span><span class="rank-name"></span><span class="rank-score"></span><button class="copy-mini" type="button" hidden>Kick</button>';
  const [rank,avatar,name,score,kick]=row.children;
  kick.dataset.kickPlayer=id;
  const entry={row,rank,avatar,name,score,kick};
  rows.set(id,entry);
  return entry;
}
const confetti = '<div class="confetti" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>';
const fireworks = '<div class="fireworks" aria-hidden="true"><i></i><i></i><i></i></div>';

function renderAnswerResult(room, solution) {
  const answer = room.me?.answer;
  const correct = answer?.correct;
  const tone = answer ? (correct ? 'success' : 'wrong') : 'neutral';
  const heading = answer
    ? (correct ? 'Chính xác!' : 'Chưa đúng!')
    : room.host ? 'Công bố đáp án' : 'Bạn chưa trả lời';
  const detail = solution.type==='hidden' ? 'Đáp án ẩn' : 'Đáp án đúng';
  return `<div class="result-card result-${tone}" role="status">
    ${correct ? confetti : ''}
    <span class="result-icon" aria-hidden="true">${answer ? (correct ? '✓' : '×') : '✦'}</span>
    <div class="result-copy"><strong>${heading}</strong>
      <span>${detail} · ${quizText(solution.text)}</span>
      ${solution.explanation ? `<p>${quizText(solution.explanation)}</p>` : ''}
    </div>
    ${answer ? `<span class="result-points">+${answer.points.toLocaleString('vi-VN')} điểm</span>` : ''}
  </div>`;
}
function renderStage(d) {
  const stage=$('#stage');
  $('video',stage)?.pause();
  const soundButton=$('#stage-video-sound');
  soundButton.hidden=true;
  soundButton.onclick=null;
  soundButton.ontouchstart=null;
  soundButton.ontouchend=null;
  if(d.phase==='lobby') {
    stage.innerHTML=`<div class="stage-lobby"><div class="stage-big-icon">🎲</div><h2>${d.host?'Chuẩn bị bùng nổ!':'Bạn đã vào phòng!'}</h2><p>${d.host?'Chia sẻ mã phòng cho bạn bè. Khi mọi người vào đủ, hãy nhấn Bắt đầu.':'Chờ quản trò bắt đầu quiz. Đừng quên để ý đáp án đặc biệt nhé!'}</p><div class="invite-code">${esc(d.code)}</div><p>Đã có <strong>${d.count}</strong> người chơi tham gia.</p></div>`;
    return;
  }
  if(d.phase==='ended') {
    const champion=state.finalRanking[0];
    const won=!!champion && d.me?.id===champion.id;
    const celebration=won || (d.host && champion);
    const title=won ? 'Bạn chiến thắng!' : d.me && champion ? 'Hẹn bạn ở trận sau!' : 'Quiz đã kết thúc';
    stage.innerHTML=`<div class="stage-end result-card result-${celebration?'success':'neutral'}" role="status">
      ${celebration?fireworks+confetti:''}
      <div class="trophy" aria-hidden="true">${celebration?'🏆':'🏁'}</div>
      <h2>${title}</h2>
      ${champion ? `<div class="winner">Hạng nhất · ${quizText(champion.name)} · ${champion.score.toLocaleString('vi-VN')}đ</div>` : ''}
      ${d.me ? `<p class="final-score">Điểm của bạn <strong>${d.me.score.toLocaleString('vi-VN')}đ</strong></p>` : ''}
    </div>`;
    return;
  }
  const q=d.question, reveal=d.phase==='reveal', solution=q.solution, answer=d.me?.answer;
  const preparing=!reveal && serverClock()<d.startsAt;
  const shownMedia=reveal?(solution?.media || q.media):q.media;
  const counts=reveal && Array.isArray(d.answerCounts) ? d.answerCounts : null;
  const totalVotes=counts?.reduce((total,count)=>total+count,0) ?? 0;
  const options=q.options.map((option,i)=>{
    const selected=answer?.choice===i, right=reveal && solution?.type==='normal' && solution.answer===i;
    const bad=reveal && selected && !right;
    const mark=right ? '<span class="choice-mark"><span class="sr-only">Đáp án đúng</span>✓</span>'
      : bad ? '<span class="choice-mark"><span class="sr-only">Bạn chọn sai</span>×</span>' : '';
    const classes=`answer-choice color-${i}${selected?' selected':''}${right?' correct-choice':''}${bad?' incorrect-choice':''}`;
    const label=`<span class="shape">${symbols[i]}</span><span class="choice-text">${quizText(option)}</span>${mark}`;
    if (reveal) {
      const count=counts?.[i] ?? 0;
      const share=totalVotes ? 100*count/totalVotes : 0;
      return `<div class="${classes} answer-result" role="listitem">
        <div class="answer-result-label">${label}</div>
        ${counts ? `<div class="vote-result">
          <div class="vote-track" aria-hidden="true"><span style="--vote-share:${share}%"></span></div>
          <span class="vote-count">${count.toLocaleString('vi-VN')} lượt chọn</span>
        </div>` : ''}
      </div>`;
    }
    return `<button type="button" data-choice="${i}" class="${classes}" ${d.host||answer?'disabled':''}>${label}</button>`;
  }).join('');
  const hint=reveal ? '' : '<div class="waiting-hint">'+(d.host?'Người chơi đang chọn đáp án.':'Chọn một đáp án.')+'</div>';
  stage.innerHTML=`${reveal ? '' : `<div id="question-countdown" class="question-countdown"${preparing?'':' hidden'}>
    <p>Câu ${d.index+1} / ${d.total}</p><strong id="countdown-number">3</strong><p>Chuẩn bị trả lời</p>
  </div>`}
    <div id="question-content" class="question-content ${reveal?'is-revealing':preparing?'is-preparing':'is-opening'}"${preparing?' inert':''}>
    <div class="stage-header"><span>✦ CÂU ${d.index+1} / ${d.total}</span>${!reveal?'<span id="available-points"></span>':'<span id="results-clock"></span>'}<span id="timer-label">${q.time}s</span></div>
    ${reveal ? renderAnswerResult(d,solution) : '<div class="timer-track"><div id="timer-value"></div></div>'}
    ${mediaMarkup(shownMedia,reveal?'reveal-media':'question-media',null,!reveal)}
    <h2 class="question-text">${quizText(q.q)}</h2>
    ${counts ? `<div class="vote-heading"><h3>Lượt chọn theo đáp án</h3><span>${totalVotes.toLocaleString('vi-VN')} đã trả lời</span></div>` : ''}
    <div class="answer-grid"${reveal?' role="list" aria-label="Kết quả theo đáp án"':''}>${options}</div>
    ${hint}</div>`;
  bindVideoSound(stage);
  if (!preparing) startStageVideo();
  if(!d.host && !reveal) {
    $$('[data-choice]',stage).forEach(btn=>btn.onclick=()=>submitAnswer(Number(btn.dataset.choice)));
  }
  if(reveal) $('#timer-label').textContent='ĐÃ CÔNG BỐ';
}
function renderActiveAnswer(d) {
  const choice=d.me?.answer?.choice;
  const pending=state.pendingAnswer?.index===d.index && state.pendingAnswer?.deadline===d.deadline;
  const expired=!timerLeft();
  const locked=choice!==undefined || pending || serverClock()<d.startsAt || expired;
  for (const button of $$('#stage [data-choice]')) {
    if (button.disabled!==locked) button.disabled=locked;
    button.classList.toggle('selected',Number(button.dataset.choice)===choice);
  }
  $('#available-points').hidden=choice!==undefined;
  setText($('#stage .waiting-hint'),expired ? 'Hết giờ. Đang chờ kết quả.' :
    choice===undefined ? 'Chọn một đáp án.' : 'Đã chốt lựa chọn. Đáp án sẽ hiện khi hết giờ.');
}
function renderHostActions(d) {
  const container=$('#host-actions');
  container.hidden=!d.host;
  if(!d.host) return;
  let label='',button='',act='';
  if(d.phase==='lobby') {label='Đang ở sảnh chờ';button='▶ Bắt đầu quiz';act='start';}
  else if(d.phase==='question') {
    label=`Đã trả lời ${d.submitted}/${d.count} người`;
    button=d.index+1>=d.total?'Bỏ qua câu cuối':'Bỏ qua câu →';
    act='skip';
  }
  else if(d.phase==='reveal') {label=`Đã công bố câu ${d.index+1}`;button=d.index+1>=d.total?'🏁 Kết thúc':'Câu tiếp theo →';act='next';}
  else {label='Đã kết thúc trận';button='↺ Chơi lại';act='reset';}
  const editButton = d.phase === 'lobby' ? '<button class="button subtle" type="button" id="host-edit-quiz">Sửa bộ câu hỏi</button>' : '';
  const closeButton = d.phase==='question'
    ? '<button class="button close-question" type="button" id="host-close-question" title="Chốt lượt trả lời và công bố đáp án ngay">Kết thúc câu</button>' : '';
  const endButton = d.phase !== 'ended' && !(d.phase !== 'lobby' && d.index + 1 >= d.total)
    ? '<button class="button subtle" type="button" id="host-end-room">Kết thúc trận</button>' : '';
  const controlsKey=[d.phase,button].join(':');
  if (container.dataset.controls!==controlsKey) {
    container.dataset.controls=controlsKey;
    container.innerHTML=`<div><strong>Điều khiển phòng</strong><p></p></div>${editButton}${endButton}${closeButton}${act?`<button class="button ${act==='skip'?'skip-question':'primary'}" type="button" id="host-main-action">${button}</button>`:''}`;
  }
  $('p',container).textContent=label;
  const pending=state.hostActionPending===state.roomSession;
  for (const control of $$('button',container)) control.disabled=pending;
  updateHostTiming(d,serverClock());
  const question={index:d.index,deadline:d.deadline};
  if(act) $('#host-main-action').onclick=()=>hostAction(act,act==='skip'?question:{});
  if(closeButton) $('#host-close-question').onclick=()=>hostAction('close-question',question);
  if(editButton) $('#host-edit-quiz').onclick=()=>openEditor(importDraft(d.hostQuiz), {code:d.code, hostToken:state.hostToken});
  if(endButton) $('#host-end-room').onclick=()=>{
    if(window.confirm('Kết thúc phòng ngay cho tất cả người chơi? Điểm hiện tại sẽ được giữ lại.')) hostAction('end');
  };
}
async function hostAction(action, details = {}) {
  const session=state.roomSession;
  if(state.hostActionPending === session) return;
  state.hostActionPending=session;
  renderHostActions(state.room);
  if (details.playerId) renderRanking(state.room);
  try {
    await api(`/api/rooms/${state.code}/action`,{hostToken:state.hostToken,action,...details});
    if(session !== state.roomSession) return;
    await poll(true);
  } catch(e) {
    if(session === state.roomSession) toast(e.message,true);
  } finally {
    if(state.hostActionPending === session) state.hostActionPending=null;
    if(session === state.roomSession) {
      renderHostActions(state.room);
      if (details.playerId) renderRanking(state.room);
    }
  }
}
async function submitAnswer(choice) {
  if(state.role!=='player' || state.room?.phase!=='question' || state.room?.me?.answer || timerLeft()<=0) return;
  if (serverClock()<state.room.startsAt) return;
  const {index,deadline}=state.room, session=state.roomSession;
  if (state.pendingAnswer?.index===index && state.pendingAnswer?.deadline===deadline) return;
  const attempt={index,deadline};
  state.pendingAnswer=attempt;
  renderActiveAnswer(state.room);
  try {
    await api(`/api/rooms/${state.code}/answer`,{playerToken:state.playerToken,choice,index,deadline});
    if(session!==state.roomSession || state.room?.phase!=='question' ||
       state.room.index!==index || state.room.deadline!==deadline) return;
    // Cho phản hồi tức thời, máy chủ vẫn tự tính điểm và xác minh đáp án.
    state.room.me.answer={choice};
    renderActiveAnswer(state.room);
    await poll();
  } catch(e) {
    if(session!==state.roomSession) return;
    toast(e.message,true);await pollSafe();
  } finally {
    if (session===state.roomSession && state.pendingAnswer===attempt) {
      state.pendingAnswer=null;
      if (state.room?.phase==='question') renderActiveAnswer(state.room);
    }
  }
}
function initRoom() {
  window.addEventListener('pagehide',notifyPlayerLeft);
  window.addEventListener('pageshow',e=>{ if (e.persisted) pollSafe(); });
  const openRanking=$('#open-ranking');
  const backToStage=$('#back-to-stage');
  if (openRanking && backToStage) {
    openRanking.onclick=()=>{
      if ($('#ranking-panel').hidden) return;
      $('#ranking-panel').scrollIntoView({block:'start'});
      $('#ranking-title').focus({preventScroll:true});
    };
    backToStage.onclick=()=>{
      openRanking.scrollIntoView({block:'start'});
      openRanking.focus({preventScroll:true});
    };
  }
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
        await api('/api/account/claim',{code,hostToken:storage.getItem('tq-host-'+code)});
        storage.removeItem('tq-host-'+code);
        storage.removeItem('tq-room-title-'+code);
        await refreshAccount();
        toast('Đã lưu phòng vào tài khoản.');
      } catch(error) { toast(error.message,true); }
      finally { claim.disabled=false; }
      return;
    }
    const button=e.target.closest('[data-open-room]');
    if(!button) return;
    const code=button.dataset.openRoom;
    const host=storage.getItem('tq-host-'+code);
    if(state.account.rooms.some(room=>room.code===code)) connectRoom(code,'host','');
    else if(host) connectRoom(code,'host',host);
    else renderSavedRooms();
  };
  $('#copy-code').onclick=()=>copyText(state.code);
  $('#copy-link').onclick=()=>copyText(roomJoinLink());
  $('#rankings').onclick=e=>{
    const playerId=e.target.closest('[data-kick-player]')?.dataset.kickPlayer;
    if (!playerId || !state.room?.host) return;
    const player=state.room.leaderboard.find(p=>p.id===playerId);
    if (player && window.confirm(`Mời ${player.name} ra khỏi phòng?`)) hostAction('kick',{playerId});
  };
  $$('[data-room-exit]').forEach(button=>button.onclick=()=>setView('home'));
  $('#stay-in-room').onclick=()=>{
    state.showFinalRanking=false;
    renderRanking(state.room);
    $('#show-final-ranking').focus();
  };
  $('#show-final-ranking').onclick=()=>{
    state.showFinalRanking=true;
    renderRanking(state.room);
    $('#ranking-title').focus();
  };
  $('#join-code').oninput=e=>e.target.value=e.target.value.toUpperCase().replace(/[^A-Z2-9]/g,'').slice(0,6);
  $('#join-form').onsubmit=async e=>{
    e.preventDefault();
    const name=$('#join-name').value.trim(),code=$('#join-code').value.trim().toUpperCase();
    if(!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) return toast('Mã phòng gồm 6 ký tự (không dùng I, O, 0, 1).',true);
    const button=$('#join-form button[type="submit"]'); button.disabled=true;
    try {
      const old=storage.getItem('tq-player-'+code);
      const result=await api(`/api/rooms/${code}/join`,{name,playerToken:old||undefined});
      storage.setItem('tq-player-'+code,result.playerToken);
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
    const host=storage.getItem('tq-host-'+code),player=storage.getItem('tq-player-'+code);
    if(state.account.rooms.some(room=>room.code===code)) await connectRoom(code,'host','');
    else if(host) await connectRoom(code,'host',host);
    else if(player) await connectRoom(code,'player',player);
    else {$('#join-code').focus(); toast('Đã điền mã phòng. Nhập tên để tham gia!');}
  }
}
boot();
