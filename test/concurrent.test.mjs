// 验收一：两个副本在同一父步骤后离线并发插入、再以相反顺序投递，
// 收敛为按稳定操作标识排序的相同步骤序列。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Replica } from '../public/core.mjs';
import { DrillSession, parseSheet, assertConverged } from '../public/drill.mjs';

function run(text) {
  const sheet = parseSheet(text);
  const s = new DrillSession(sheet.replicaCount);
  sheet.lines.forEach((l) => s.apply(l));
  return s;
}

const SHEET = `
REPLICAS 2
GEN a insert 主级点火 parent=root seq=1
HOLD b insert 俯仰修正 parent=a seq=2
HOLD c insert 滚转修正 parent=a seq=2
DELIVER b R1
DELIVER c R1
DELIVER c R2
DELIVER b R2
`;

test('逆序投递后两副本序列完全一致（稳定标识排序）', () => {
  const s = run(SHEET);
  assert.ok(assertConverged(s), '终态应收敛');
  for (const r of s.replicas) {
    const ids = r.snapshot().sequence.map((x) => x.id);
    assert.deepEqual(ids, ['a', 'b', 'c'], '兄弟顺序按稳定操作标识 b<c');
  }
});

test('投递过程中 R1 先见 b、R2 先见 c：中间态不同，终态相同', () => {
  const sheet = parseSheet(SHEET);
  const s = new DrillSession(2);
  // 先登记（GEN a 全员投递；b/c 全员滞留）
  s.apply(sheet.lines[0]);
  s.apply(sheet.lines[1]);
  s.apply(sheet.lines[2]);
  s.apply(sheet.lines[3]); // DELIVER b R1
  assert.deepEqual(s.replicas[0].snapshot().sequence.map((x) => x.id), ['a', 'b']);
  assert.deepEqual(s.replicas[1].snapshot().sequence.map((x) => x.id), ['a']);
  s.apply(sheet.lines[4]); // DELIVER c R1
  s.apply(sheet.lines[5]); // DELIVER c R2
  s.apply(sheet.lines[6]); // DELIVER b R2
  assert.ok(assertConverged(s));
});

test('三、四副本同样收敛', () => {
  for (const n of [3, 4]) {
    const extra = Array.from({ length: n - 2 }, (_, i) => `DELIVER b R${i + 3}\nDELIVER c R${i + 3}`).join('\n');
    const text = SHEET.replace('REPLICAS 2', `REPLICAS ${n}`) + '\n' + extra;
    const s = run(text);
    assert.ok(assertConverged(s));
  }
});

test('直接用 Replica API 手工构造逆序投递', () => {
  const mk = () => {
    const r = new Replica('R');
    r.gen({ id: 'a', op: 'insert', payload: { label: '根步', parent: null, seq: 1 } }, { hold: true });
    r.gen({ id: 'b', op: 'insert', payload: { label: '乙', parent: 'a', seq: 2 } }, { hold: true });
    r.gen({ id: 'c', op: 'insert', payload: { label: '丙', parent: 'a', seq: 2 } }, { hold: true });
    return r;
  };
  const r1 = mk(); r1.deliver('a'); r1.deliver('b'); r1.deliver('c');
  const r2 = mk(); r2.deliver('a'); r2.deliver('c'); r2.deliver('b');
  const s1 = r1.snapshot().sequence.map((x) => x.id);
  const s2 = r2.snapshot().sequence.map((x) => x.id);
  assert.deepEqual(s1, ['a', 'b', 'c']);
  assert.deepEqual(s2, ['a', 'b', 'c']);
});
