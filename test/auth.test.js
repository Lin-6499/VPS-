import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, normalizeUsername, validatePassword } from '../src/auth.js';

test('password hashes use salted scrypt and verify without exposing the password',async()=>{
  const password='correct horse battery staple';
  const first=await hashPassword(password),second=await hashPassword(password);
  assert.notEqual(first,second);
  assert.match(first,/^scrypt\$32768\$8\$1\$/);
  assert.equal(await verifyPassword(password,first),true);
  assert.equal(await verifyPassword('wrong password value',first),false);
  assert.equal(first.includes(password),false);
});

test('admin credentials enforce normalized usernames and strong password length',()=>{
  assert.equal(normalizeUsername(' Admin.User '),'admin.user');
  assert.throws(()=>normalizeUsername('a'));
  assert.throws(()=>normalizeUsername('管理员'));
  assert.throws(()=>validatePassword('too-short'));
  assert.equal(validatePassword('twelve-chars!'),'twelve-chars!');
});
