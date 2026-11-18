import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuiz, publicQuestion, scoreAnswer, mediaPath } from '../src/logic.js';
const draft = { title:'Bài test', questions:[
  { q:'Câu 1', options:['A','B'], answer:1, time:20 },
  { q:'Câu 2', options:['A','B','C','D','E'], hidden:{text:'Không có',msg:'Plot twist!'},time:15 }
] };
test('validate variable options + secret question',()=>{
  const quiz=normalizeQuiz(draft);
  assert.equal(quiz.questions[0].options.length,2);
  assert.equal(quiz.questions[1].options.length,5);
  assert.equal(quiz.questions[1].hidden.text,'Không có');
});
test('không leak đáp án khi đang chơi',()=>{
  const quiz=normalizeQuiz(draft);
  const publicQ=publicQuestion(quiz.questions[0]);
  assert.equal(publicQ.answer,undefined);
  assert.equal(publicQ.solution,undefined);
  assert.equal(publicQuestion(quiz.questions[0],true).solution.answer,1);
  assert.equal(publicQuestion(quiz.questions[1],true).solution.type,'hidden');
});
test('điểm giảm theo thời gian và câu ẩn luôn được 0 điểm',()=>{
  const q=normalizeQuiz(draft).questions;
  assert.deepEqual(scoreAnswer(q[0],0,0,0,20000),{correct:false,points:0});
  assert.deepEqual(scoreAnswer(q[0],1,0,0,20000),{correct:true,points:1000});
  assert.deepEqual(scoreAnswer(q[0],1,10000,0,20000),{correct:true,points:750});
  assert.deepEqual(scoreAnswer(q[0],1,20000,0,20000),{correct:true,points:500});
  assert.throws(()=>scoreAnswer(q[1],-1,5000,0,15000),/Lựa chọn không hợp lệ/);
  q[1].options.forEach((_,choice)=>{
    assert.deepEqual(scoreAnswer(q[1],choice,5000,0,15000),{correct:false,points:0});
  });
});
test('từ chối dữ liệu quiz không hợp lệ',()=>{
  assert.throws(()=>normalizeQuiz({questions:[{q:'?',options:['A'],answer:0}]}));
  assert.throws(()=>normalizeQuiz({questions:[{q:'?',options:['A','B'],answer:3}]}));
  assert.throws(()=>normalizeQuiz({questions:[{q:'?',options:['A','B'],hidden:{text:''}}]}));
  assert.throws(()=>normalizeQuiz({questions:[{q:'?',options:['A','B'],answer:1,time:3}]}));
});
test('chỉ chấp nhận media HTTPS / path nội bộ',()=>{
  assert.equal(mediaPath('javascript:alert(1)'),'');
  assert.equal(mediaPath('http://unsafe.example/a.gif'),'');
  assert.equal(mediaPath('https://a.example/a.gif'),'https://a.example/a.gif');
  assert.equal(mediaPath('/api/media/rooms/ABCDEF/123e4567-e89b-12d3-a456-426614174000.mp4'),'/api/media/rooms/ABCDEF/123e4567-e89b-12d3-a456-426614174000.mp4');
});
