// app.mjs —— 页面逻辑

const $ = (id) => document.getElementById(id);

// 初始态（尚无任何动作）的空副本快照
const emptySnap = (name) => ({
  name, sequence: [], visible: [], underTombstone: [], tombstones: [],
  waiting: [], firstReject: null, rejected: [], applied: [], applyCount: 0
});

const EXAMPLES = {
  concurrent: `# 两个副本：同一父步骤 a 之后离线并发插入 b/c，再以相反顺序投递，
# 兄弟顺序由稳定操作标识排序决定 → 两副本收敛为相同序列。
REPLICAS 2
GEN a insert 主级点火 parent=root seq=1
HOLD b insert 俯仰修正 parent=a seq=2
HOLD c insert 滚转修正 parent=a seq=2
DELIVER b R1
DELIVER c R1
DELIVER c R2
DELIVER b R2`,

  undo: `# 先撤销祖先 a，随后其下合法子步骤 b（及孙 c）才送达：
# 祖先保留为不可见墓碑，子步骤仍按稳定标识出现在正确位置（标注于墓碑之下）。
REPLICAS 2
GEN a insert 助推器分离 parent=root seq=1
HOLD b insert 尾段修正 parent=a seq=2
HOLD c insert 尾段修正-子 parent=b seq=3
GEN u-a undo target=a
DELIVER b
DELIVER c`,

  reject: `# 缺失父项 / 复用标识篡改载荷 / 越界序号（篡改投递）：定位首个拒因，既有投影不变；重复投递幂等。
REPLICAS 2
GEN a insert 帆板展开 parent=root seq=1
GEN b insert 飞轮启动 parent=a seq=2
HOLD x1 insert 无记录父项分支 parent=zzz seq=1
HOLD t1 insert 序号将被改大 parent=root seq=3
HOLD tamper insert 原载荷 parent=a seq=4
DELIVER x1
DELIVER t1 R1 SET seq=99
DELIVER tamper R1 SET label=被篡改的标签
DELIVER tamper R2
DELIVER b
DELIVER b`,

  recovery: `# 乱序等待：子项先投递（依赖未定→等待），父项后到后级联生效且仅应用一次；
# e 全程滞留：执行完刷新/重开页面后，在下方“继续接收投递”发送 DELIVER e。
REPLICAS 2
HOLD a insert 入轨总检 parent=root seq=1
HOLD d insert 晚到的合法子项 parent=a seq=2
HOLD e insert 重开后补发的子项 parent=a seq=3
DELIVER d
DELIVER a
DELIVER d`,
};

let state = null;       // 服务端返回的完整状态
let framePos = 0;       // 0 = 初始（无帧），1..N = 第 N 帧后
let playTimer = null;

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function resultCls(r) {
  if (r?.waiting) return 'wait';
  if (r?.ok) return 'ok';
  return 'bad';
}

function render() {
  const tpl = $('replicaTpl');
  const wrap = $('replicas');
  wrap.innerHTML = '';

  if (!state) {
    $('convBanner').className = 'banner idle';
    $('convBanner').textContent = '尚未执行';
    $('frameRange').max = 0;
    $('frameRange').value = 0;
    $('frameLabel').textContent = '帧 0 / 0';
    $('frameLog').innerHTML = '<span class="dim">粘贴演练单后点“整段执行”，或载入示例。</span>';
    return;
  }

  const total = state.frames.length;
  // 中间帧可能暂未收敛（正常的离线中间态）；终态必须收敛
  const shownFrame = framePos >= total ? null : framePos;
  let snapshots;
  if (shownFrame === null) {
    snapshots = state.snapshots;
    $('convBanner').className = `banner ${state.converged ? 'ok' : 'bad'}`;
    $('convBanner').textContent = state.converged ? '✓ 副本间已收敛为相同序列' : '✗ 副本间序列不一致';
  } else if (shownFrame === 0) {
    // 第 0 帧：尚无动作，全部为空快照
    snapshots = state.snapshots.map((s) => emptySnap(s.name));
    $('convBanner').className = 'banner idle';
    $('convBanner').textContent = '初始态：尚无动作';
  } else {
    snapshots = state.frames[shownFrame - 1].snapshots;
    const convergedNow = sameSeq(snapshots);
    $('convBanner').className = `banner ${convergedNow ? 'ok' : 'bad'}`;
    $('convBanner').textContent = convergedNow
      ? `✓ 第 ${shownFrame} 帧副本一致（可能为中间态）`
      : `… 第 ${shownFrame} 帧副本暂不一致（离线/逆序中间态）`;
  }

  $('frameRange').max = total;
  $('frameRange').value = framePos;
  $('frameLabel').textContent = `帧 ${framePos} / ${total}`;

  const frame = shownFrame === null ? null : (shownFrame === 0 ? false : state.frames[shownFrame - 1]);
  renderFrameLog(frame);

  snapshots.forEach((snap) => {
    const node = tpl.content.cloneNode(true);
    node.querySelector('.replica-name').textContent = `${snap.name}（${snap.sequence.length} 项）`;
    node.querySelector('.applied-count').textContent = `已应用记录 ${[...new Set(snap.applied)].length} 条·应用 ${snap.applyCount} 次（仅一次）`;

    const seqEl = node.querySelector('.seq-list');
    if (snap.sequence.length === 0) {
      seqEl.innerHTML = '<li class="empty">（空）</li>';
    } else {
      snap.sequence.forEach((s) => {
        const li = document.createElement('li');
        if (s.underTombstone) li.className = 'under';
        li.innerHTML = `<span class="lbl">${esc(s.label)}</span> <span class="pid">[${esc(s.id)}]</span>
          <span class="note">seq=${s.seq}${s.parent ? `·父=${esc(s.parent)}` : ''}${s.note ? `·${esc(s.note)}` : ''}</span>`;
        seqEl.appendChild(li);
      });
    }

    const tombEl = node.querySelector('.tomb-list');
    if (snap.tombstones.length === 0) {
      tombEl.innerHTML = '<li class="empty">无</li>';
    } else {
      snap.tombstones.forEach((id) => {
        const li = document.createElement('li');
        li.innerHTML = `${esc(id)} <span class="why">· 保留但不可见，子项不株连</span>`;
        tombEl.appendChild(li);
      });
    }

    const waitEl = node.querySelector('.wait-list');
    if (snap.waiting.length === 0) {
      waitEl.innerHTML = '<li class="empty">无</li>';
    } else {
      snap.waiting.forEach((w) => {
        const li = document.createElement('li');
        li.textContent = `${w.id} · ${w.reason}`;
        waitEl.appendChild(li);
      });
    }

    const fr = snap.firstReject;
    node.querySelector('.first-reject').innerHTML = fr
      ? `首个拒因：<span class="rid">${esc(fr.id)}</span> · ${esc(fr.reason)}`
      : '<span class="empty">无拒绝记录</span>';

    const allOl = node.querySelector('.all-rejects ol');
    if (snap.rejected.length === 0) {
      allOl.innerHTML = '<li><span class="empty">无</span></li>';
    } else {
      snap.rejected.forEach((r) => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="r">${esc(r.id)}</span> · ${esc(r.reason)}`;
        allOl.appendChild(li);
      });
    }

    wrap.appendChild(node);
  });
}

function renderFrameLog(frame) {
  if (frame === false) {
    $('frameLog').innerHTML = '<span class="dim">初始态：尚无动作被执行。</span>';
    return;
  }
  if (!frame) {
    $('frameLog').innerHTML = '<span class="dim">已在终态。可用 ◀ 逐帧回看离线收敛过程。</span>';
    return;
  }
  const parts = [`#${frame.index} <b>${esc(frame.raw)}</b>`];
  frame.results.forEach((r) => {
    const cls = resultCls(r.result);
    const tag = r.result?.waiting ? '等待' : r.result?.ok ? (r.result.duplicate ? '重复·幂等' : '生效') : '拒绝';
    parts.push(`<div><span class="dim">${r.name}:</span> <span class="${cls}">${tag}</span>${r.result?.reason && !r.result?.waiting ? ` · ${esc(r.result.reason)}` : ''}</div>`);
  });
  $('frameLog').innerHTML = parts.join('');
}

function sameSeq(snaps) {
  const sig = (s) => s.sequence.map((x) => `${x.id}${x.underTombstone ? '~' : ''}`).join('|');
  const first = sig(snaps[0]);
  return snaps.every((s) => sig(s) === first);
}

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function refreshState() {
  const res = await fetch('/api/state');
  state = await res.json();
  framePos = state ? state.frames.length : 0;
  render();
}

async function runSheet() {
  stopShow();
  const info = $('parseInfo');
  info.className = 'parse-info';
  try {
    const data = await api('/api/run', { sheet: $('sheet').value });
    state = data.state;
    framePos = state.frames.length;
    info.textContent = `已执行 ${state.linesApplied} 个动作 · ${state.replicaCount} 副本 · 终态${data.converged ? '收敛' : '未收敛'}`;
    render();
  } catch (err) {
    info.className = 'parse-info error';
    info.textContent = err.message;
  }
}

async function appendLine() {
  stopShow();
  const input = $('appendLine');
  const info = $('parseInfo');
  info.className = 'parse-info';
  try {
    const data = await api('/api/append', { line: input.value });
    state = data.state;
    framePos = state.frames.length;
    info.textContent = `投递已记录并持久化（${state.linesApplied} 条动作日志）· 终态${data.converged ? '收敛' : '继续等待依赖'}`;
    render();
    input.value = '';
  } catch (err) {
    info.className = 'parse-info error';
    info.textContent = err.message;
  }
}

function gotoFrame(n) {
  if (!state) return;
  framePos = Math.max(0, Math.min(state.frames.length, n));
  render();
}

function startShow() {
  if (!state) return;
  if (playTimer) { stopShow(); return; }
  $('btnPlay').textContent = '⏸ 暂停';
  playTimer = setInterval(() => {
    if (framePos >= state.frames.length) { stopShow(); return; }
    gotoFrame(framePos + 1);
  }, 900);
}
function stopShow() {
  if (playTimer) { clearInterval(playTimer); playTimer = null; $('btnPlay').textContent = '▶ 自动'; }
}

// 初次加载即恢复持久化状态（“刷新或关闭后恢复”）
refreshState().catch(() => {});

$('btnRun').addEventListener('click', runSheet);
$('btnReset').addEventListener('click', async () => {
  await api('/api/reset', {});
  state = null;
  $('parseInfo').textContent = '';
  render();
});
$('btnAppend').addEventListener('click', appendLine);
$('appendLine').addEventListener('keydown', (e) => { if (e.key === 'Enter') appendLine(); });
$('btnFirst').addEventListener('click', () => { stopShow(); gotoFrame(0); });
$('btnPrev').addEventListener('click', () => { stopShow(); gotoFrame(framePos - 1); });
$('btnNext').addEventListener('click', () => { stopShow(); gotoFrame(framePos + 1); });
$('btnLast').addEventListener('click', () => { stopShow(); gotoFrame(state.frames.length); });
$('frameRange').addEventListener('input', (e) => { stopShow(); gotoFrame(Number(e.target.value)); });
$('btnPlay').addEventListener('click', startShow);

document.querySelectorAll('.examples button').forEach((btn) => {
  btn.addEventListener('click', () => {
    $('sheet').value = EXAMPLES[btn.dataset.example];
    $('parseInfo').textContent = '示例已载入，点击“整段执行”';
    $('parseInfo').className = 'parse-info';
  });
});
