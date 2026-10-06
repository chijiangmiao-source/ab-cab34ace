// 验收二：先撤销祖先，再收到其下合法子步骤——
// 祖先保留为不可见墓碑；子步骤不被拒绝、不株连，仍出现在正确位置。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DrillSession, parseSheet, assertConverged } from '../public/drill.mjs';

function run(text) {
  const sheet = parseSheet(text);
  const s = new DrillSession(sheet.replicaCount);
  sheet.lines.forEach((l) => s.apply(l));
  return s;
}

const SHEET = `
REPLICAS 2
GEN a insert 助推器分离 parent=root seq=1
HOLD b insert 尾段修正 parent=a seq=2
HOLD c insert 尾段修正-子 parent=b seq=3
GEN u-a undo target=a
DELIVER b
DELIVER c
`;

test('祖先先成墓碑，迟到合法子步骤仍应用并位于正确位置', () => {
  const s = run(SHEET);
  assert.ok(assertConverged(s), '两副本仍应收敛');
  for (const r of s.replicas) {
    const snap = r.snapshot();
    // a 不可见但保留为墓碑
    assert.deepEqual(snap.tombstones, ['a']);
    // b、c 不被拒绝：仍在序列中，且按稳定标识的先序位置 a→b→c（a 隐藏后为 b,c）
    assert.deepEqual(snap.sequence.map((x) => x.id), ['b', 'c']);
    const b = snap.sequence.find((x) => x.id === 'b');
    const c = snap.sequence.find((x) => x.id === 'c');
    assert.equal(b.underTombstone, true);
    assert.deepEqual(b.tombstoneAncestors, ['a']);
    assert.equal(c.underTombstone, true);
    assert.deepEqual(c.tombstoneAncestors, ['a'], 'b 自身非墓碑，墓碑祖先仅 a');
    // 无拒因：合法子项不得因祖先撤销而被定位为拒绝
    assert.equal(snap.firstReject, null);
  }
});

test('子步骤先到并等待，随后祖先被撤销，依赖齐备时级联应用且只一次', () => {
  // 先投递 b（a 尚未投递 → waiting），再投递 a 并立即撤销，等待的 b 级联生效
  const text = `
REPLICAS 2
HOLD a insert 立柱段 parent=root seq=1
HOLD b insert 立柱端子项 parent=a seq=2
DELIVER b
GEN u-a undo target=a
DELIVER a
`;
  const s = run(text);
  // 当 a 应用后级联：b 的依赖 a 已存在（虽随即墓碑），b 仍须应用
  for (const r of s.replicas) {
    const snap = r.snapshot();
    assert.deepEqual(snap.tombstones.sort(), ['a']);
    assert.deepEqual(snap.sequence.map((x) => x.id), ['b']);
    assert.equal(snap.sequence[0].underTombstone, true);
    // insert a + undo + insert b 各应用一次
    const counts = snap.applyCount;
    assert.equal(counts, 3);
    assert.deepEqual(snap.waiting, []);
  }
});

test('撤销不存在的目标 → 目标缺失拒因；撤销重复投递不新增墓碑', () => {
  const sheet = parseSheet(`
REPLICAS 2
HOLD a insert 根 parent=root seq=1
HOLD u-ghost undo target=ghost
DELIVER u-ghost
DELIVER a
DELIVER u-ghost
`);
  const s = new DrillSession(2);
  sheet.lines.forEach((l) => s.apply(l));
  for (const r of s.replicas) {
    const snap = r.snapshot();
    assert.equal(snap.firstReject.id, 'u-ghost');
    assert.equal(snap.firstReject.reason, '撤销目标缺失');
    assert.deepEqual(snap.tombstones, []);
  }
});
