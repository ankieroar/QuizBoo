// Pure logic — không phụ thuộc Cloudflare, có unit tests.
export const MAX_QUESTIONS = 100;
export const MAX_OPTIONS = 8;
export const DEFAULT_TIME = 20;

function plain(value, limit = 500) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}
export function mediaPath(s) {
  s = plain(s, 1500);
  if (!s) return '';
  if (/^https:\/\//i.test(s)) return s;
  if (/^\/(api\/media\/[a-zA-Z0-9/_-]+\.[a-zA-Z0-9]+|media\/[a-zA-Z0-9/_-]+\.[a-zA-Z0-9]+)$/i.test(s)) return s;
  if (/^media\/[a-zA-Z0-9/_-]+\.[a-zA-Z0-9]+$/i.test(s)) return '/' + s;
  return '';
}
export function normalizeQuiz(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.questions) || !input.questions.length || input.questions.length > MAX_QUESTIONS) {
    throw new Error(`Quiz cần từ 1 đến ${MAX_QUESTIONS} câu hỏi.`);
  }
  const questions = input.questions.map((raw, i) => {
    const q = plain(raw.q ?? raw.question, 600);
    const options = Array.isArray(raw.options) ? raw.options.map(x => plain(x, 260)) : [];
    if (!q || options.length < 2 || options.length > MAX_OPTIONS || options.some(x => !x)) {
      throw new Error(`Câu ${i + 1}: cần nội dung và 2–${MAX_OPTIONS} đáp án không rỗng.`);
    }
    const time = Number(raw.time ?? input.time ?? DEFAULT_TIME);
    if (!Number.isFinite(time) || time < 5 || time > 120) throw new Error(`Câu ${i + 1}: thời gian phải từ 5 đến 120 giây.`);
    const hidden = raw.hidden && typeof raw.hidden === 'object' ? {
      text: plain(raw.hidden.text, 260),
      msg: plain(raw.hidden.msg, 600),
      media: mediaPath(raw.hidden.media || raw.revealMedia || '')
    } : null;
    if (hidden && !hidden.text) throw new Error(`Câu ${i + 1}: đáp án ẩn phải có nội dung.`);
    const answer = Number(raw.answer);
    if (!hidden && (!Number.isInteger(answer) || answer < 0 || answer >= options.length || raw.answer === undefined || raw.answer === null || raw.answer === '')) {
      throw new Error(`Câu ${i + 1}: đáp án đúng phải là vị trí từ 0 đến ${options.length - 1}, hoặc dùng hidden.`);
    }
    return { q, options, answer: hidden ? null : answer, hidden,
      media: mediaPath(raw.media),
      revealMedia: mediaPath(raw.revealMedia ?? raw.answerMedia ?? ''),
      explanation: plain(raw.explanation, 800), time: Math.round(time) };
  });
  return { title: plain(input.title, 90) || 'Troll Quiz', questions };
}
export function publicQuestion(q, reveal = false) {
  const data = { q: q.q, options: q.options, media: q.media, time: q.time };
  if (reveal) {
    data.solution = q.hidden
      ? { type: 'hidden', text: q.hidden.text, explanation: q.hidden.msg || 'Không có đáp án nào ở trên đúng!', media: q.hidden.media || q.revealMedia }
      : { type: 'normal', answer: q.answer, text: q.options[q.answer], explanation: q.explanation || '', media: q.revealMedia };
  }
  return data;
}
export function scoreAnswer(q, choice, now, start, deadline) {
  const valid = Number.isInteger(choice) && choice >= 0 && choice < q.options.length;
  if (!valid) throw new Error('Lựa chọn không hợp lệ.');
  const correct = !q.hidden && choice === q.answer;
  if (!correct) return { correct: false, points: 0 };
  const duration = Math.max(1, deadline - start);
  const fraction = Math.max(0, Math.min(1, (deadline - now) / duration));
  return { correct: true, points: Math.round(500 + 500 * fraction) };
}
