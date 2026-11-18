import {readFileSync,writeFileSync} from 'node:fs';
const id=process.argv[2];
if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id||'')) {
  console.error('Cách dùng: node scripts/set-db-id.mjs <database_id trả về bởi wrangler d1 create>');
  process.exit(1);
}
const file=new URL('../wrangler.jsonc',import.meta.url);
const content=readFileSync(file,'utf8');
writeFileSync(file,content.replace(/"database_id"\s*:\s*"[^"]+"/,`"database_id": "${id}"`));
console.log('Đã cập nhật D1 database_id trong wrangler.jsonc');
