import process from 'node:process';
import { createPool, migrate } from './db.js';
import { hashPassword, normalizeUsername, validatePassword } from './auth.js';

function argument(name, fallback) {
  const index=process.argv.indexOf(`--${name}`);
  if(index>=0&&process.argv[index+1])return process.argv[index+1];
  const inline=process.argv.find(value=>value.startsWith(`--${name}=`));
  return inline?inline.slice(name.length+3):fallback;
}

function hidden(prompt) {
  return new Promise((resolve,reject)=>{
    if(!process.stdin.isTTY)return reject(new Error('该命令需要在交互式终端中运行'));
    process.stdout.write(prompt);process.stdin.setRawMode(true);process.stdin.resume();process.stdin.setEncoding('utf8');let value='';
    const finish=(error)=>{process.stdin.setRawMode(false);process.stdin.pause();process.stdin.off('data',onData);process.stdout.write('\n');error?reject(error):resolve(value);};
    const onData=char=>{if(char==='\u0003')return finish(new Error('已取消'));if(char==='\r'||char==='\n')return finish();if(char==='\u007f'||char==='\b'){if(value){value=value.slice(0,-1);process.stdout.write('\b \b');}return;}if(char>=' '){value+=char;process.stdout.write('•');}};
    process.stdin.on('data',onData);
  });
}

const action=process.argv[2],username=normalizeUsername(argument('username','admin'));
if(!['create','reset-password'].includes(action))throw new Error('用法：npm run admin:create -- --username admin，或 npm run admin:reset-password -- --username admin');
const password=validatePassword(await hidden('新密码（12–128 个字符）：'));
const confirmation=await hidden('再次输入新密码：');
if(password!==confirmation)throw new Error('两次输入的密码不一致');
const pool=createPool();
try{
  await migrate(pool);const encoded=await hashPassword(password);
  if(action==='create'){
    const [[count]]=await pool.query('SELECT COUNT(*) count FROM admin_users');
    if(Number(count.count))throw new Error('管理员已经存在；如需改密请执行 npm run admin:reset-password');
    await pool.execute('INSERT INTO admin_users(username,password_hash) VALUES (?,?)',[username,encoded]);
    console.log(`管理员 ${username} 已创建。`);
  }else{
    const [result]=await pool.execute('UPDATE admin_users SET password_hash=?,password_changed_at=UTC_TIMESTAMP(3),enabled=TRUE WHERE username=?',[encoded,username]);
    if(!result.affectedRows)throw new Error('管理员不存在');
    await pool.execute('UPDATE auth_sessions SET revoked_at=UTC_TIMESTAMP(3) WHERE user_id=(SELECT id FROM admin_users WHERE username=?) AND revoked_at IS NULL',[username]);
    console.log(`管理员 ${username} 的密码已重置，现有会话已撤销。`);
  }
}finally{await pool.end();}
