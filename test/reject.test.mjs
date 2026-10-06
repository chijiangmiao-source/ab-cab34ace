// 拒因与边界：复用标识篡改载荷 / 缺失父项 / 越界序号 → 定位首个拒因，既有投影不变。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Replica, REASON } from '../public/core.mjs';
import { DrillSession, parseSheet } from '../public/drill.mjs';

function insertEnv(id, patch = {}) {
  return { id, op: 'insert', payload: { label: '步', parent: null, seq: 1, note: '', ...patch } };
}

test('复用操作标识但篡改载荷 → 拒绝，且既有投影不变', () => {
  const r = new Replica('R1');
  r.gen(insertEnv('a'), { hold: true });
  r.deliver('a');
  const before = JSON.stringify(r.snapshot().sequence);

  // 同 id 携带被篡改的完整信封
  const tampered = insertEnv('a', { label: '被改写', seq: 7 });
  const res = r.deliver('a', tampered);
  assert.equal(res.ok, false);
  assert.equal(res.reason, REASON.PAYLOAD_TAMPERED);
  const snap = r.snapshot();
  assert.equal(snap.firstReject.id, 'a');
  assert.equal(snap.firstReject.reason, REASON.PAYLOAD_TAMPERED);
  // 既有投影不变：a 仍是原载荷，且未新增节点
  assert.equal(JSON.stringify(snap.sequence), before);
  assert.equal(snap.sequence[0].label, '步');
  assert.equal(snap.applyCount, 1);
});

test('篡改 payload 中 seq/parent/note 任一字段都被识别', () => {
  for (const patch of [{ seq: 2 }, { parent: 'x' }, { note: 'x' }]) {
    const r = new Replica('R1');
    r.gen(insertEnv('a'), { hold: true });
    r.deliver('a');
    const res = r.deliver('a', insertEnv('a', patch));
    assert.equal(res.reason, REASON.PAYLOAD_TAMPERED, JSON.stringify(patch));
  }
});

test('缺失父项：父操作无记录 → 缺失操作记录拒因，不产生半截投影', () => {
  const r = new Replica('R1');
  r.gen(insertEnv('a', { parent: 'ghost' }), { hold: true });
  const res = r.deliver('a');
  assert.equal(res.ok, false);
  assert.equal(res.reason, REASON.PARENT_MISSING);
  const snap = r.snapshot();
  assert.equal(snap.firstReject.id, 'a');
  assert.equal(snap.firstReject.reason, REASON.PARENT_MISSING);
  assert.deepEqual(snap.sequence, []);
});

test('越界序号：seq 非 0..40 整数 → 序号越界', () => {
  for (const seq of [99, -1, 1.5, '2']) {
    const r = new Replica('R1');
    const res = r.gen(insertEnv('t', { seq }), { hold: true });
    assert.equal(res.ok, false, `seq=${seq}`);
    assert.equal(res.reason, REASON.SEQ_OUT_OF_RANGE);
  }
  // seq=0 与 40 合法
  for (const seq of [0, 40]) {
    const r = new Replica('R1');
    const res = r.gen(insertEnv('t', { seq }));
    assert.equal(res.ok, true);
  }
});

test('首个拒因按投递次序定位，且后来的合法动作不改变既有投影之外的历史', () => {
  const sheet = parseSheet(`
REPLICAS 2
GEN a insert 根 parent=root seq=1
HOLD x1 insert 缺父 parent=zzz seq=1
HOLD t1 insert 序号将被改大 parent=root seq=2
DELIVER x1
DELIVER t1 R1 SET seq=99
DELIVER t1 R2 SET seq=99
`);
  const s = new DrillSession(2);
  sheet.lines.forEach((l) => s.apply(l));
  for (const r of s.replicas) {
    const snap = r.snapshot();
    assert.equal(snap.firstReject.id, 'x1', '首个拒因是最早被拒的 x1');
    assert.equal(snap.firstReject.reason, REASON.PARENT_MISSING);
    assert.deepEqual(snap.sequence.map((x) => x.id), ['a']);
    assert.deepEqual(snap.rejected.map((x) => x.id), ['x1', 't1']);
    assert.equal(snap.rejected[1].reason, REASON.SEQ_OUT_OF_RANGE);
  }
});

test('演练单解析阶段即拒绝非法 GEN（越界/缺字段），带行号定位', () => {
  assert.throws(() => parseSheet('REPLICAS 2\nGEN a insert x seq=99'), /序号越界/);
  assert.throws(() => parseSheet('REPLICAS 2\nGEN a insert x'), /序号越界|不合法/);
  assert.throws(() => parseSheet('REPLICAS 2\nGEN a undo'), /不合法/);
});

test('篡改载荷的投递不影响另一副本的规范投影', () => {
  const sheet = parseSheet(`
REPLICAS 2
GEN a insert 帆板 parent=root seq=1
HOLD tamper insert 原载荷 parent=a seq=3
DELIVER tamper R1 SET label=被篡改
DELIVER tamper R2
`);
  const s = new DrillSession(2);
  sheet.lines.forEach((l) => s.apply(l));
  const r1 = s.replicas[0].snapshot();
  const r2 = s.replicas[1].snapshot();
  assert.equal(r1.firstReject.id, 'tamper');
  assert.equal(r1.firstReject.reason, REASON.PAYLOAD_TAMPERED);
  assert.deepEqual(r1.sequence.map((x) => x.id), ['a']);
  // R2 收到规范投递 → tamper 合法生效
  assert.deepEqual(r2.sequence.map((x) => x.id), ['a', 'tamper']);
  assert.equal(r2.firstReject, null);
});

test('等待项的依赖被硬拒时，等待项随之定格拒因，不永久挂起', () => {
  const r = new Replica('R1');
  r.gen(insertEnv('p', { parent: 'ghost' }), { hold: true }); // ghost 永不出现
  r.gen(insertEnv('c', { label: '孙', parent: 'p' }), { hold: true });
  assert.equal(r.deliver('c').waiting, true);
  const res = r.deliver('p'); // 父项规范投递 → 硬拒（父项操作缺失）
  assert.equal(res.reason, REASON.PARENT_MISSING);
  const snap = r.snapshot();
  assert.deepEqual(snap.waiting, [], '不再有悬挂的等待项');
  assert.deepEqual(snap.rejected.map((x) => x.id).sort(), ['c', 'p']);
  const cRej = snap.rejected.find((x) => x.id === 'c');
  assert.equal(cRej.reason, REASON.PARENT_MISSING);
  assert.deepEqual(snap.sequence, []);
});

test('坏数据包只拒绝该信封：之后规范投递仍可生效并收敛（可自愈）', () => {
  const r = new Replica('R1');
  r.gen(insertEnv('a'), { hold: true });
  r.gen(insertEnv('b', { label: '原载荷', parent: 'a' }), { hold: true });
  r.deliver('a');
  // 先到的篡改信封被丢
  const bad = r.deliver('b', insertEnv('b', { label: '被篡改', parent: 'a' }));
  assert.equal(bad.reason, REASON.PAYLOAD_TAMPERED);
  let snap = r.snapshot();
  assert.deepEqual(snap.sequence.map((x) => x.id), ['a'], '既有投影不变');
  assert.equal(snap.firstReject.id, 'b');
  assert.equal(snap.firstReject.reason, REASON.PAYLOAD_TAMPERED);
  // 规范信封随后到达 → 生效；历史拒因仍在审计中可查
  const ok = r.deliver('b');
  assert.equal(ok.ok, true);
  snap = r.snapshot();
  assert.deepEqual(snap.sequence.map((x) => x.id), ['a', 'b']);
  assert.equal(snap.sequence[1].label, '原载荷');
  assert.equal(snap.applyCount, 2);
  assert.ok(snap.rejected.some((x) => x.id === 'b' && x.reason === REASON.PAYLOAD_TAMPERED), '历史拒因留痕');
});

test('动作上限 40、副本数 2–4 的表单约束', () => {
  assert.throws(() => parseSheet('REPLICAS 1\nGEN a insert x seq=1'), /2–4/);
  assert.throws(() => parseSheet('REPLICAS 5\nGEN a insert x seq=1'), /2–4/);
  const tooMany = Array.from({ length: 41 }, (_, i) => `GEN a${i} insert 步 seq=${i}`).join('\n');
  assert.throws(() => parseSheet(`REPLICAS 2\n${tooMany}`), /超过上限 40/);
  const ok = Array.from({ length: 40 }, (_, i) => `GEN a${i} insert 步 seq=${i}`).join('\n');
  const parsed = parseSheet(`REPLICAS 2\n${ok}`);
  assert.equal(parsed.lines.length, 40);
});
