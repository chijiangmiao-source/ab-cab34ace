// scripts/smoke.mjs —— HTTP 冒烟：健康接口 + 页面 + 三套验收场景端到端
// 用法：node scripts/smoke.mjs [BASE_URL]
const BASE = process.argv[2] || process.env.BASE_URL || 'http://127.0.0.1:8080';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
};

async function jpost(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}

async function main() {
  console.log(`[smoke] 目标 ${BASE}`);

  // 1) 健康接口
  const hres = await fetch(BASE + '/healthz');
  const hjson = await hres.json();
  check('GET /healthz 返回 200', hres.status === 200);
  check('GET /healthz {ok:true}', hjson.ok === true);

  // 2) 页面与静态资源
  const pres = await fetch(BASE + '/');
  const phtml = await pres.text();
  check('GET / 返回 200 HTML', pres.status === 200 && /text\/html/.test(pres.headers.get('content-type') || ''));
  check('页面含演练台标题', phtml.includes('多副本收敛演练台'));
  for (const asset of ['/app.mjs', '/core.mjs', '/drill.mjs', '/styles.css']) {
    const r = await fetch(BASE + asset);
    check(`静态资源 ${asset} 可访问`, r.status === 200);
  }

  // 3) 验收场景一：离线并发插入、逆序投递 → 收敛
  await jpost('/api/reset', {});
  const concurrent = `REPLICAS 2
GEN a insert 主级点火 parent=root seq=1
HOLD b insert 俯仰修正 parent=a seq=2
HOLD c insert 滚转修正 parent=a seq=2
DELIVER b R1
DELIVER c R1
DELIVER c R2
DELIVER b R2`;
  const r1 = await jpost('/api/run', { sheet: concurrent });
  check('场景一：执行成功且终态收敛', r1.status === 200 && r1.json.ok && r1.json.converged === true);
  const seq1 = r1.json.state.snapshots[0].sequence.map((s) => s.id).join(',');
  check('场景一：序列为 a,b,c（稳定标识排序）', seq1 === 'a,b,c', `实际 ${seq1}`);
  check('场景一：两副本序列一致',
    r1.json.state.snapshots.every((s) => s.sequence.map((x) => x.id).join(',') === seq1));

  // 4) 验收场景二：祖先撤销后的迟到合法子项
  const undo = `REPLICAS 2
GEN a insert 助推器分离 parent=root seq=1
HOLD b insert 尾段修正 parent=a seq=2
HOLD c insert 尾段修正-子 parent=b seq=3
GEN u-a undo target=a
DELIVER b
DELIVER c`;
  const r2 = await jpost('/api/run', { sheet: undo });
  check('场景二：终态收敛', r2.json.converged === true);
  for (const snap of r2.json.state.snapshots) {
    check('场景二：祖先保留为墓碑', snap.tombstones.includes('a'));
    check('场景二：迟到子项仍在正确位置', snap.sequence.map((s) => s.id).join(',') === 'b,c');
    check('场景二：子项标注于墓碑之下且无拒因',
      snap.sequence.every((s) => s.underTombstone) && snap.firstReject === null);
  }

  // 5) 验收场景三：滞留 + 重开恢复 + 继续接收投递
  const recovery = `REPLICAS 2
GEN a insert 入轨总检 parent=root seq=1
HOLD e insert 重开后补发的子项 parent=a seq=2`;
  const r3 = await jpost('/api/run', { sheet: recovery });
  check('场景三：初始仅 a 可见',
    r3.json.state.snapshots.every((s) => s.sequence.map((x) => x.id).join(',') === 'a'));
  // 模拟重开：重新拉取状态
  const stateAfterReopen = await (await fetch(BASE + '/api/state')).json();
  check('场景三：重开后日志与序列恢复一致',
    stateAfterReopen.linesApplied === 2 &&
    stateAfterReopen.snapshots.every((s) => s.sequence.map((x) => x.id).join(',') === 'a'));
  // 继续接收此前滞留的合法投递
  const r4 = await jpost('/api/append', { line: 'DELIVER e' });
  check('场景三：滞留投递被接收并收敛', r4.status === 200 && r4.json.converged === true);
  check('场景三：e 出现在正确位置且仅应用一次',
    r4.json.state.snapshots.every((s) =>
      s.sequence.map((x) => x.id).join(',') === 'a,e' && s.applyCount === 2));
  // 再次重开：持久化仍一致
  const stateFinal = await (await fetch(BASE + '/api/state')).json();
  check('场景三：再次恢复后序列/日志不变',
    stateFinal.linesApplied === 3 &&
    stateFinal.snapshots.every((s) => s.sequence.map((x) => x.id).join(',') === 'a,e'));

  // 6) 非法投递不改投影（篡改载荷）
  await jpost('/api/run', { sheet: `REPLICAS 2
GEN a insert 帆板 parent=root seq=1
HOLD t insert 原载荷 parent=a seq=2
DELIVER t R1 SET label=被篡改` });
  const rj = await (await fetch(BASE + '/api/state')).json();
  check('篡改投递：首个拒因已定位', rj.snapshots[0].firstReject?.reason === '载荷与生成记录不一致');
  check('篡改投递：既有投影不变', rj.snapshots[0].sequence.map((x) => x.id).join(',') === 'a');

  console.log(failures === 0 ? '\n[smoke] 全部通过' : `\n[smoke] ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[smoke] 致命错误：', err);
  process.exit(1);
});
