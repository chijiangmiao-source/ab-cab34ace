// 验收三：刷新/关闭（会话序列化→重建）后，
// 操作日志、副本状态恢复为相同的可见序列、等待操作与已应用记录，
// 并能继续接收此前滞留的合法投递。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Replica } from '../public/core.mjs';
import { DrillSession, parseSheet, assertConverged } from '../public/drill.mjs';

test('乱序：子项先到等待，父项补齐后仅应用一次；重复投递不新增', () => {
  const r = new Replica('R1');
  r.gen({ id: 'a', op: 'insert', payload: { label: '父', parent: null, seq: 1 } }, { hold: true });
  r.gen({ id: 'd', op: 'insert', payload: { label: '子', parent: 'a', seq: 2 } }, { hold: true });

  const first = r.deliver('d');
  assert.equal(first.waiting, true);
  assert.deepEqual(r.snapshot().sequence, []);
  assert.deepEqual(r.snapshot().waiting.map((w) => w.id), ['d']);

  r.deliver('a'); // 依赖齐备 → d 级联应用
  const snap1 = r.snapshot();
  assert.deepEqual(snap1.sequence.map((x) => x.id), ['a', 'd']);
  assert.deepEqual(snap1.waiting, []);
  assert.equal(snap1.applyCount, 2, 'a 与 d 各应用一次');

  // 重复投递：幂等，不新增步骤，不增加应用次数
  const dup1 = r.deliver('d');
  const dup2 = r.deliver('d');
  assert.equal(dup1.duplicate, true);
  const snap2 = r.snapshot();
  assert.equal(snap2.sequence.length, 2);
  assert.equal(snap2.applyCount, 2, '重复投递绝不再应用');
});

test('序列化→重建：序列/等待/已应用/墓碑/拒因全部一致', () => {
  const sheet = parseSheet(`
REPLICAS 2
GEN a insert 总检 parent=root seq=1
HOLD d insert 晚到子项 parent=a seq=2
HOLD e insert 另一个晚到子项 parent=a seq=3
HOLD x insert 缺父分支 parent=zzz seq=1
DELIVER d
DELIVER x
`);
  const s = new DrillSession(2);
  sheet.lines.forEach((l) => s.apply(l));

  const restored = DrillSession.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
  assert.equal(restored.linesApplied, s.linesApplied);
  assert.deepEqual(
    restored.frames.map((f) => f.raw),
    s.frames.map((f) => f.raw),
    '操作日志完整恢复'
  );

  for (let i = 0; i < 2; i++) {
    const before = s.replicas[i].snapshot();
    const after = restored.replicas[i].snapshot();
    assert.deepEqual(after.sequence, before.sequence);
    assert.deepEqual(after.waiting, before.waiting);
    assert.deepEqual(after.firstReject, before.firstReject);
    assert.deepEqual(after.tombstones, before.tombstones);
    assert.deepEqual([...new Set(after.applied)], [...new Set(before.applied)]);
  }
  assert.ok(assertConverged(restored));
});

test('重开后继续接收此前滞留的合法投递，等待项被应用且终态收敛', () => {
  const sheet = parseSheet(`
REPLICAS 2
GEN a insert 总检 parent=root seq=1
HOLD e insert 重开后补发的子项 parent=a seq=2
`);
  const s = new DrillSession(2);
  sheet.lines.forEach((l) => s.apply(l));

  // 模拟关闭→重开
  const reopened = DrillSession.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
  assert.deepEqual(reopened.replicas[0].snapshot().waiting, []);

  // 此前滞留（已生成未投递）的合法投递到达
  const frame = reopened.applyText('DELIVER e');
  assert.equal(frame.results.length, 2);
  assert.ok(frame.results.every((r) => r.result.ok));
  for (const r of reopened.replicas) {
    const snap = r.snapshot();
    assert.deepEqual(snap.sequence.map((x) => x.id), ['a', 'e']);
    assert.equal(snap.applyCount, 2);
  }
  assert.ok(assertConverged(reopened));
});

test('等待中的操作随持久化保留，重建后补齐依赖照样级联', () => {
  const r = new Replica('R1');
  r.gen({ id: 'p', op: 'insert', payload: { label: '父', parent: null, seq: 1 } }, { hold: true });
  r.gen({ id: 'q', op: 'insert', payload: { label: '子', parent: 'p', seq: 2 } }, { hold: true });
  r.deliver('q'); // waiting
  const r2 = Replica.fromJSON(JSON.parse(JSON.stringify(r.toJSON())));
  assert.deepEqual(r2.snapshot().waiting.map((w) => w.id), ['q']);
  r2.deliver('p');
  assert.deepEqual(r2.snapshot().sequence.map((x) => x.id), ['p', 'q']);
  assert.deepEqual(r2.snapshot().waiting, []);
});
