// drill.mjs —— 演练单解析与多副本编排
//
// 演练单语法（每行一条，# 开头为注释，空行忽略）：
//   REPLICAS 2|3|4                      副本数（默认 2）
//   GEN <id> insert <label> [parent=<id|root>] seq=<0..40> [note=<...>]
//   GEN <id> undo target=<id>
//   HOLD <id> insert ...                生成并在各副本登记，但先滞留不投递（离线）
//   HOLD <id> undo target=<id>
//   DELIVER <id> [R1,R2]                向指定副本投递（默认全部）；未生成的 id 即“缺失父项/操作”
//   DELIVER <id> [R1,R2] SET k=v ...    复用操作标识但携带篡改后的信封
//
// 规则：GEN/HOLD 的规范信封在所有副本登记（操作标识与其权威载荷全局可知），
// 是否改变投影只取决于 DELIVER。动作总数（GEN+HOLD+DELIVER 行）上限 40。

import { Replica, OP, REASON, validateEnvelope } from './core.mjs';

export const LIMITS = Object.freeze({ MIN_REPLICAS: 2, MAX_REPLICAS: 4, MAX_ACTIONS: 40 });

export class DrillError extends Error {}

function tokenize(line) {
  const tokens = [];
  const re = /(\S+)="((?:[^"\\]|\\.)*)"|(\S+)=(\S+)|"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (m[1] !== undefined) tokens.push({ kv: true, key: m[1], val: unquote(m[2]) });
    else if (m[3] !== undefined) tokens.push({ kv: true, key: m[3], val: m[4] });
    else if (m[5] !== undefined) tokens.push({ kv: false, val: unquote(m[5]) });
    else tokens.push({ kv: false, val: m[6] });
  }
  return tokens;
}

function unquote(s) {
  return s.replace(/\\(.)/g, '$1');
}

function kv(tokens, key) {
  const t = tokens.find((t) => t.kv && t.key === key);
  return t ? t.val : undefined;
}

function positional(tokens, start) {
  return tokens.slice(start).filter((t) => !t.kv).map((t) => t.val);
}

// 解析 insert/undo 的信封字段
function buildEnvelope(id, kind, tokens) {
  if (kind === 'insert') {
    // tokens 的位置参数形如 [GEN|HOLD, id, insert, label...]，标签从第 4 个位置起
    const poss = positional(tokens, 0).slice(3);
    const label = kv(tokens, 'label') ?? poss[0];
    const parentRaw = kv(tokens, 'parent') ?? 'root';
    const seqRaw = kv(tokens, 'seq');
    const note = kv(tokens, 'note') ?? '';
    return {
      id,
      op: OP.INSERT,
      payload: { label, parent: parentRaw === 'root' ? null : parentRaw, seq: seqRaw === undefined ? undefined : Number(seqRaw), note }
    };
  }
  if (kind === 'undo') {
    const target = kv(tokens, 'target');
    return { id, op: OP.UNDO, payload: { target } };
  }
  throw new DrillError(`未知操作类型：${kind}`);
}

export function parseSheet(text) {
  const lines = [];
  const rawLines = text.split(/\r?\n/);
  rawLines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const tokens = tokenize(trimmed);
    const head = tokens[0]?.val;

    if (head === 'REPLICAS') {
      const n = Number(positional(tokens, 1)[0]);
      if (![2, 3, 4].includes(n)) throw new DrillError(`第 ${lineNo} 行：副本数须为 2–4`);
      lines.push({ type: 'replicas', n, raw: trimmed });
      return;
    }

    if (head === 'GEN' || head === 'HOLD') {
      const [, id, kind] = positional(tokens, 0);
      if (!id || !kind) throw new DrillError(`第 ${lineNo} 行：${head} 需要 <id> <insert|undo>`);
      const env = buildEnvelope(id, kind, tokens);
      const check = validateEnvelope(env);
      if (check.error) throw new DrillError(`第 ${lineNo} 行（${id}）：${check.error}`);
      lines.push({ type: head.toLowerCase(), id, env: check.value, raw: trimmed });
      return;
    }

    if (head === 'DELIVER') {
      const rest = positional(tokens, 0);
      const id = rest[1];
      if (!id) throw new DrillError(`第 ${lineNo} 行：DELIVER 需要 <id>`);
      let targets = null;
      const targetToken = rest[2];
      if (targetToken && /^R[1-4](,\s*R[1-4])*$/.test(targetToken)) {
        targets = targetToken.split(',').map((s) => s.trim());
      }
      const setIdx = tokens.findIndex((t) => !t.kv && t.val === 'SET');
      let override = null;
      if (setIdx >= 0) {
        const setTokens = tokens.slice(setIdx + 1);
        // 篡改信封：以 SET 给出的字段覆盖规范记录
        override = { _patch: Object.fromEntries(setTokens.filter((t) => t.kv).map((t) => [t.key, t.val])) };
      }
      lines.push({ type: 'deliver', id, targets, override, raw: trimmed });
      return;
    }

    throw new DrillError(`第 ${lineNo} 行：无法识别的指令“${head}”`);
  });

  const replicaLines = lines.filter((l) => l.type === 'replicas');
  if (replicaLines.length > 1) throw new DrillError('REPLICAS 至多声明一次');
  const replicaCount = replicaLines[0]?.n ?? 2;
  const actions = lines.filter((l) => l.type !== 'replicas');
  if (actions.length === 0) throw new DrillError('演练单为空');
  if (actions.length > LIMITS.MAX_ACTIONS) throw new DrillError(`动作 ${actions.length} 项，超过上限 ${LIMITS.MAX_ACTIONS} 项`);

  return { replicaCount, lines: actions, rawLines };
}

export class DrillSession {
  constructor(replicaCount) {
    this.replicaCount = replicaCount;
    this.replicas = Array.from({ length: replicaCount }, (_, i) => new Replica(`R${i + 1}`));
    /** 每帧：{raw, type, targets:[名字], results:[{name, result}], snapshots:[...]} */
    this.frames = [];
    this.linesApplied = 0;
  }

  apply(line, canonicals) {
    const names = this.replicas.map((r) => r.name);
    const targets = line.targets ?? names;
    const results = [];

    if (line.type === 'gen' || line.type === 'hold') {
      // 规范信封在所有副本登记（全局可知），GEN 随即全员投递，HOLD 全员滞留
      for (const r of this.replicas) {
        const res = r.gen(line.env, { hold: line.type === 'hold' });
        results.push({ name: r.name, result: res });
      }
    } else if (line.type === 'deliver') {
      for (const name of targets) {
        const r = this.replicas.find((x) => x.name === name);
        if (!r) throw new DrillError(`未知副本：${name}`);
        let override;
        if (line.override) {
          const canon = r.records.get(line.id);
          if (!canon) {
            // 无规范记录时的篡改投递仍走正常流程 → 缺失操作记录
            override = undefined;
          } else {
            override = patchEnvelope(canon, line.override._patch);
          }
          results.push({ name, result: r.deliver(line.id, override) });
        } else {
          results.push({ name, result: r.deliver(line.id) });
        }
      }
    } else {
      throw new DrillError(`未知动作类型：${line.type}`);
    }

    this.linesApplied++;
    const frame = {
      index: this.frames.length + 1,
      raw: line.raw,
      type: line.type,
      id: line.id,
      targets: line.type === 'deliver' ? targets : names,
      results,
      snapshots: this.replicas.map((r) => r.snapshot())
    };
    this.frames.push(frame);
    return frame;
  }

  // 追加运行时指令块（重开后继续接收此前滞留的合法投递）；返回新增帧
  applyTextBlock(raw) {
    const parsed = parseSheet(`REPLICAS ${this.replicaCount}\n${raw}`);
    if (this.linesApplied + parsed.lines.length > LIMITS.MAX_ACTIONS) {
      throw new DrillError(`累计动作将超过上限 ${LIMITS.MAX_ACTIONS} 项（已有 ${this.linesApplied}）`);
    }
    return parsed.lines.map((line) => this.apply(line));
  }

  // 追加单条指令；返回该帧
  applyText(raw) {
    const frames = this.applyTextBlock(raw);
    if (frames.length === 0) throw new DrillError('缺少动作');
    return frames[0];
  }

  toJSON() {
    return {
      replicaCount: this.replicaCount,
      replicas: this.replicas.map((r) => r.toJSON()),
      frames: this.frames,
      linesApplied: this.linesApplied
    };
  }

  static fromJSON(data) {
    const s = new DrillSession(data.replicaCount);
    s.replicas = data.replicas.map((d) => Replica.fromJSON(d));
    s.frames = data.frames;
    s.linesApplied = data.linesApplied;
    return s;
  }
}

function patchEnvelope(canon, patch) {
  const env = JSON.parse(JSON.stringify(canon));
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'op') { env.op = v; continue; }
    if (k === 'target') { env.payload.target = v; continue; }
    if (k === 'label') env.payload.label = v;
    else if (k === 'note') env.payload.note = v;
    else if (k === 'parent') env.payload.parent = v === 'root' ? null : v;
    else if (k === 'seq') env.payload.seq = Number(v);
  }
  return env;
}

// 收敛断言：各副本可见序列（含墓碑位置标注）完全一致
export function assertConverged(session) {
  const sig = (snap) =>
    snap.sequence.map((s) => `${s.id}${s.underTombstone ? '~' : ''}`).join(',');
  const first = sig(session.replicas[0].snapshot());
  for (let i = 1; i < session.replicas.length; i++) {
    if (sig(session.replicas[i].snapshot()) !== first) return false;
  }
  return true;
}

export { REASON };
