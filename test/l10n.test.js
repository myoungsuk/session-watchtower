'use strict';
// 글자(영어·한국어)와 꾸러미 설정이 서로 맞는지 확인한다.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const json = (f) => JSON.parse(read(f));
const placeholders = (s) => (s.match(/\{\d\}/g) || []).sort().join(',');

function keysInCode() {
  const src = read('extension.js');
  const keys = new Set();
  const re = /\bL\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;
  let m;
  while ((m = re.exec(src))) keys.add(JSON.parse('"' + m[2].replace(/\\'/g, "'").replace(/"/g, '\\"') + '"'));
  return keys;
}

test('화면 글자마다 한국어 번역이 있고 자리표시자가 같다', () => {
  const ko = json('l10n/bundle.l10n.ko.json');
  const keys = keysInCode();
  assert.ok(keys.size > 80, '글자를 충분히 찾아야 함: ' + keys.size);
  const missing = [...keys].filter((k) => !(k in ko));
  assert.deepStrictEqual(missing, [], '번역이 없는 글자');
  const unused = Object.keys(ko).filter((k) => !keys.has(k));
  assert.deepStrictEqual(unused, [], '쓰지 않는 번역');
  const bad = Object.keys(ko).filter((k) => placeholders(k) !== placeholders(ko[k]));
  assert.deepStrictEqual(bad, [], '자리표시자가 다른 번역');
});

test('꾸러미 설정의 %이름%이 영어·한국어 파일에 모두 있다', () => {
  const en = json('package.nls.json');
  const ko = json('package.nls.ko.json');
  assert.deepStrictEqual(Object.keys(en).sort(), Object.keys(ko).sort());
  const used = new Set((read('package.json').match(/"%([^%"]+)%"/g) || []).map((s) => s.slice(2, -2)));
  assert.deepStrictEqual([...used].filter((k) => !(k in en)), [], '정의가 없는 이름');
  assert.deepStrictEqual(Object.keys(en).filter((k) => !used.has(k)), [], '쓰지 않는 이름');
});

test('꾸러미에 넣을 파일이 모두 있고, 시험·비공개 파일은 들어가지 않는다', () => {
  const pkg = json('package.json');
  for (const f of pkg.files) {
    if (f.includes('*')) continue;
    assert.ok(fs.existsSync(path.join(root, f)), '없는 파일: ' + f);
  }
  assert.ok(!pkg.files.some((f) => f.startsWith('test')), '시험 폴더는 꾸러미에 넣지 않는다');
  assert.ok(fs.existsSync(path.join(root, pkg.main)));
  assert.ok(!('preview' in pkg), '미리 보기 표시는 뺐다');
  for (const c of pkg.contributes.commands) assert.ok(read('extension.js').includes(`'${c.command}'`), '등록 안 된 명령: ' + c.command);
});
