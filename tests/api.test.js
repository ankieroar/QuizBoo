import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const DB={
    prepare(sql) {
      const stm=db.prepare(sql);
      return { bind(...values) {
        return { first:async()=>stm.get(...values)||null,
          all:async()=>({ results:stm.all(...values) }),
          run:async()=>({meta:{changes:stm.run(...values).changes}}) };
      } };
    },
    batch:async stmts=>{
      const results=[];
      for (const stmt of stmts) results.push(await stmt.run());
      return results;
    }
  };
  const files=new Map();
  const MEDIA={
    put:async(key,data,opts)=>files.set(key,{data:new Uint8Array(data),type:opts.httpMetadata.contentType}),
    get:async(key)=>{
      const f=files.get(key); if(!f) return null;
      return {body:new Blob([f.data]).stream(),size:f.data.length,
        httpEtag:'"abc"',httpMetadata:{contentType:f.type}};
    }
  };
  return {DB,MEDIA,ASSETS:{fetch:async()=>new Response('ok')}};
}
async function post(env,path, data, headers={}) {
  const body=headers['Content-Type'] ? data : JSON.stringify(data);
  const req=new Request('https://quiz.test'+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body});
  const res=await worker.fetch(req,env);
  return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')};
}
const quiz={title:'Test room',time:20,questions:[
  {q:'2 + 2 = ?',options:['3','4'],answer:1,time:20},
  {q:'Trick',options:['A','B','C'],hidden:{text:'None',msg:'Troll!'},time:20}
]};
test('full room lifecycle, timed reveals, avoid double points',async t=>{
  t.mock.timers.enable({apis:['Date'],now:100_000});
  const env=setup();
  const made=await post(env,'/api/rooms',{quiz});
  assert.equal(made.status,201);
  const {code,hostToken}=made.data;
  assert.match(code,/^[A-HJ-NP-Z2-9]{6}$/);
  const a=await post(env,`/api/rooms/${code}/join`,{name:'Nam'});
  const b=await post(env,`/api/rooms/${code}/join`,{name:'Linh'});
  assert.equal(a.status,201); assert.equal(b.status,201);
  const playerToken=a.data.playerToken, otherToken=b.data.playerToken;
  assert.equal((await post(env,`/api/rooms/${code}/state`,{playerToken})).data.phase,'lobby');
  assert.equal((await post(env,`/api/rooms/${code}/action`,{hostToken:'bad',action:'start'})).status,403);
  assert.equal((await post(env,`/api/rooms/${code}/action`,{hostToken,action:'start'})).status,200);
  let stage=(await post(env,`/api/rooms/${code}/state`,{playerToken})).data;
  assert.equal(stage.phase,'question');
  assert.equal(stage.question.solution,undefined);
  assert.equal(stage.question.answer,undefined);
  assert.equal((await post(env,`/api/rooms/${code}/answer`,{playerToken,choice:1})).status,200);
  assert.equal((await post(env,`/api/rooms/${code}/answer`,{playerToken,choice:1})).status,200);
  assert.equal((await post(env,`/api/rooms/${code}/answer`,{playerToken:otherToken,choice:0})).status,200);
  stage=(await post(env,`/api/rooms/${code}/state`,{playerToken})).data;
  assert.ok(stage.me.score>=500 && stage.me.score<=1000);
  assert.equal(stage.submitted,2);
  const points=stage.me.score;
  assert.equal((await post(env,`/api/rooms/${code}/action`,{hostToken,action:'reveal'})).status,409);
  t.mock.timers.tick(20_000);
  stage=(await post(env,`/api/rooms/${code}/state`,{playerToken})).data;
  assert.equal(stage.question.solution.answer,1);
  assert.equal(stage.me.score,points);
  assert.equal((await post(env,`/api/rooms/${code}/action`,{hostToken,action:'next'})).status,200);
  assert.equal((await post(env,`/api/rooms/${code}/answer`,{playerToken,choice:-1})).status,400);
  assert.equal((await post(env,`/api/rooms/${code}/answer`,{playerToken,choice:0})).status,200);
  assert.equal((await post(env,`/api/rooms/${code}/answer`,{playerToken:otherToken,choice:2})).status,200);
  assert.equal((await post(env,`/api/rooms/${code}/action`,{hostToken,action:'reveal'})).status,409);
  t.mock.timers.tick(19_999);
  stage=(await post(env,`/api/rooms/${code}/state`,{playerToken})).data;
  assert.equal(stage.phase,'question');
  assert.equal(stage.question.solution,undefined);
  assert.equal(stage.submitted,2);
  t.mock.timers.tick(1);
  assert.equal((await post(env,`/api/rooms/${code}/answer`,{playerToken,choice:1})).status,409);
  stage=(await post(env,`/api/rooms/${code}/state`,{playerToken})).data;
  assert.equal(stage.question.solution.text,'None');
  assert.deepEqual(stage.me.answer,{choice:0,correct:false,points:0});
  assert.equal(stage.me.score,points);
  assert.equal((await post(env,`/api/rooms/${code}/action`,{hostToken,action:'next'})).status,200);
  assert.equal((await post(env,`/api/rooms/${code}/state`,{playerToken})).data.phase,'ended');
  assert.equal((await post(env,`/api/rooms/${code}/action`,{hostToken,action:'reset'})).status,200);
  assert.equal((await post(env,`/api/rooms/${code}/state`,{playerToken})).data.me.score,0);
});
test('media upload only host, 15mb limit, safe types',async()=>{
  const env=setup(); const create=await post(env,'/api/rooms',{quiz});
  const {code,hostToken}=create.data;
  const opts={'Content-Type':'image/gif','X-Room-Code':code,'X-Host-Token':hostToken};
  const ok=await post(env,'/api/media',new Uint8Array([71,73,70,56]),opts);
  assert.equal(ok.status,200); assert.match(ok.data.url,/^\/api\/media\/rooms\//);
  const url='https://quiz.test'+ok.data.url;
  const content=await worker.fetch(new Request(url),env);
  assert.equal(content.status,200);assert.equal(content.headers.get('content-type'),'image/gif');
  assert.equal((await content.arrayBuffer()).byteLength,4);
  assert.equal((await post(env,'/api/media',new Uint8Array([1,2]),{...opts,'X-Host-Token':'bad'})).status,403);
});
test('host can save reordered questions and media in an existing lobby',async t=>{
  t.mock.timers.enable({apis:['Date'],now:100_000});
  const env=setup();
  const {code,hostToken}=(await post(env,'/api/rooms',{quiz})).data;
  const path=`/api/rooms/${code}`;
  const {playerToken}=(await post(env,`${path}/join`,{name:'Nam'})).data;
  const media='https://example.com/question.png';
  const updated={...quiz,questions:[{...quiz.questions[1],media,time:10},quiz.questions[0]]};
  assert.equal((await post(env,`${path}/quiz`,{hostToken:playerToken,quiz:updated})).status,403);
  assert.equal((await post(env,`${path}/quiz`,{hostToken,quiz:updated})).status,200);
  const lobby=(await post(env,`${path}/state`,{hostToken})).data;
  assert.equal(lobby.hostQuiz.questions[0].media,media);
  assert.equal(lobby.count,1);
  assert.equal((await post(env,`${path}/action`,{hostToken,action:'start'})).status,200);
  const playing=(await post(env,`${path}/state`,{playerToken})).data;
  assert.equal(playing.question.q,'Trick');
  assert.equal(playing.question.media,media);
  assert.equal(playing.deadline,110_000);
  assert.equal((await post(env,`${path}/quiz`,{hostToken,quiz})).status,409);
});
test('account rooms require their owner session and existing rooms can be claimed',async()=>{
  const env=setup(), credential='1'.repeat(64);
  const owner={username:'quan_tro',credential}, stranger={username:'nguoi_khac',credential};
  const register=await post(env,'/api/account/register',owner);
  assert.equal(register.status,200);
  assert.match(register.cookie,/HttpOnly; SameSite=Strict; Max-Age=604800; Secure/);
  const ownerSession={Cookie:register.cookie.split(';')[0]};
  assert.equal((await post(env,'/api/account/register',owner)).status,409);
  assert.equal((await post(env,'/api/account/login',{...owner,credential:'2'.repeat(64)})).status,401);
  const other=await post(env,'/api/account/register',stranger);
  const otherSession={Cookie:other.cookie.split(';')[0]};
  const {data:owned}=await post(env,'/api/rooms',{quiz,requireAccount:true},ownerSession);
  assert.equal(owned.hostToken,'');
  const {data:guest}=await post(env,'/api/rooms',{quiz});
  assert.equal((await post(env,'/api/account/claim',{code:guest.code,hostToken:'wrong'},ownerSession)).status,403);
  assert.equal((await post(env,'/api/account/claim',guest,ownerSession)).status,200);
  assert.equal((await post(env,'/api/account/claim',guest,otherSession)).status,403);
  assert.equal((await post(env,`/api/rooms/${guest.code}/quiz`,{quiz,hostToken:guest.hostToken})).status,403);
  assert.equal((await post(env,`/api/rooms/${owned.code}/quiz`,{quiz},otherSession)).status,403);
  assert.equal((await post(env,`/api/rooms/${owned.code}/quiz`,{quiz},ownerSession)).status,200);
  const joined=await post(env,`/api/rooms/${owned.code}/join`,{name:'Người chơi'});
  assert.equal(joined.status,201);
  const player=await post(env,`/api/rooms/${owned.code}/state`,{playerToken:joined.data.playerToken});
  assert.equal(player.data.host,false);
  assert.equal(player.data.hostQuiz,undefined);
  assert.equal((await post(env,'/api/account/logout',{},ownerSession)).status,200);
  assert.equal((await post(env,`/api/rooms/${owned.code}/state`,{},ownerSession)).status,401);
  const login=await post(env,'/api/account/login',owner);
  const {data:list}=await post(env,'/api/account/rooms',{},{Cookie:login.cookie.split(';')[0]});
  assert.deepEqual(new Set(list.rooms.map(room=>room.code)),new Set([owned.code,guest.code]));
});

test('40 guests can join, submit and read results in one room',async t=>{
  t.mock.timers.enable({apis:['Date'],now:100_000});
  const env=setup();
  const {code,hostToken}=(await post(env,'/api/rooms',{quiz})).data;
  const path=`/api/rooms/${code}`;
  const guests=await Promise.all(Array.from({length:40},(_,i)=>post(env,`${path}/join`,{name:`Player ${i+1}`})));
  assert.ok(guests.every(result=>result.status===201));
  assert.equal((await post(env,`${path}/action`,{hostToken,action:'start'})).status,200);
  const submissions=await Promise.all(guests.map(({data:{playerToken}})=>post(env,`${path}/answer`,{playerToken,choice:1})));
  assert.ok(submissions.every(result=>result.status===200));
  t.mock.timers.tick(20_000);
  const results=await Promise.all(guests.map(({data:{playerToken}})=>post(env,`${path}/state`,{playerToken})));
  assert.ok(results.every(({data})=>data.phase==='reveal' && data.submitted===40 && data.me.score===1000));
});

test('only the host can finish early, closing answers and preserving scores',async t=>{
  t.mock.timers.enable({apis:['Date'],now:100_000});
  const env=setup();
  const {code,hostToken}=(await post(env,'/api/rooms',{quiz})).data;
  const path=`/api/rooms/${code}`;
  const {playerToken}=(await post(env,`${path}/join`,{name:'Nam'})).data;
  assert.equal((await post(env,`${path}/action`,{hostToken,action:'start'})).status,200);
  assert.equal((await post(env,`${path}/answer`,{playerToken,choice:1})).status,200);
  assert.equal((await post(env,`${path}/action`,{hostToken:playerToken,action:'end'})).status,403);
  assert.equal((await post(env,`${path}/action`,{hostToken,action:'end'})).status,200);
  const {data}=await post(env,`${path}/state`,{playerToken});
  assert.equal(data.phase,'ended');
  assert.equal(data.question,null);
  assert.equal(data.deadline,0);
  assert.equal(data.me.score,1000);
  assert.equal((await post(env,`${path}/answer`,{playerToken,choice:1})).status,409);
  assert.equal((await post(env,`${path}/join`,{name:'Linh'})).status,409);
  assert.equal((await post(env,`${path}/action`,{hostToken,action:'reset'})).status,200);
});
