// core.mjs —— 姿控步骤单多副本收敛引擎（Node / 浏览器同构）
//
// 概念：
//   步骤(step)：步骤单上的一个可见项，具有父步骤，兄弟之间按“稳定操作标识”定序。
//   动作(action)：
//     gen      生成某操作标识的规范信封（权威载荷），可追加等待标记。
//     deliver  投递某操作标识。可简写（省略 op/payload，按 gen 规范重放），
//              也可携带完整信封以模拟“复用操作标识但篡改载荷”。
//   操作(op)：insert（插入步骤）/ undo（撤销步骤，仅该元素打墓碑，不株连子步）。
//   状态：
//     MISSING  操作尚未出现（连生成都没有）
//     WAITING  已见信封，但父项依赖未齐备（乱序等待）
//     READY    依赖齐备但尚未应用
//     APPLIED  已应用（insert 进入树 / undo 打墓碑），仅一次
//     REJECTED 校验未过：记录首个拒因，且既有投影不变
//
// 序列收敛：同一生成步骤集合下，各副本无论投递顺序如何，
// 树的兄弟顺序由稳定操作标识字典序决定，撤销只切可见性，故先序遍历必然相同。

export const OP = Object.freeze({
  INSERT: 'insert',
  UNDO: 'undo'
});

export const STATUS = Object.freeze({
  MISSING: 'missing',
  WAITING: 'waiting',
  READY: 'ready',
  APPLIED: 'applied',
  REJECTED: 'rejected'
});

export const REASON = Object.freeze({
  MISSING_OP: '缺失操作记录',
  PAYLOAD_TAMPERED: '载荷与生成记录不一致',
  MALFORMED: '信封字段不合法',
  SEQ_OUT_OF_RANGE: '序号越界',
  PARENT_MISSING: '父项操作缺失',
  TARGET_MISSING: '撤销目标缺失',
  ALREADY: '重复投递'
});

const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;

// 稳定操作标识排序：字典序（生成时刻即确定，不随投递顺序变化）
export function compareId(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// 校验信封形状，返回 {value} 或 {error}
export function validateEnvelope(env) {
  return normalizeEnvelope(env);
}

function normalizeEnvelope(env) {
  if (!env || typeof env !== 'object') return { error: REASON.MALFORMED };
  const id = env.id;
  const op = env.op;
  if (!isNonEmptyString(id)) return { error: REASON.MALFORMED };
  if (op !== OP.INSERT && op !== OP.UNDO) return { error: REASON.MALFORMED };

  if (op === OP.INSERT) {
    const p = env.payload;
    if (!p || typeof p !== 'object') return { error: REASON.MALFORMED };
    // 序号越界优先定位（演练单明确列出的拒因）
    if (!Number.isInteger(p.seq) || p.seq < 0 || p.seq > 40) return { error: REASON.SEQ_OUT_OF_RANGE };
    if (!isNonEmptyString(p.label)) return { error: REASON.MALFORMED };
    const parent = p.parent === undefined || p.parent === null ? null : p.parent;
    if (parent !== null && !isNonEmptyString(parent)) return { error: REASON.MALFORMED };
    return {
      value: {
        id,
        op,
        payload: { label: p.label, parent, seq: p.seq, note: isNonEmptyString(p.note) ? p.note : '' },
        deps: parent === null ? [] : [parent]
      }
    };
  }

  // undo
  const p = env.payload;
  if (!p || typeof p !== 'object') return { error: REASON.MALFORMED };
  if (!isNonEmptyString(p.target)) return { error: REASON.MALFORMED };
  return {
    value: { id, op, payload: { target: p.target }, deps: [p.target] }
  };
}

// 深度冻结，杜绝外部持有的对象被事后篡改
function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  Object.values(obj).forEach(deepFreeze);
  return Object.freeze(obj);
}

export class Replica {
  constructor(name = 'R') {
    this.name = name;
    /** 已生成的规范信封：id -> 冻结信封 */
    this.records = new Map();
    /** 投递状态：id -> {status, order, envelope?(投递时信封), reason?} */
    this.state = new Map();
    /** 已应用的插入：id -> {id, label, parent, seq, note, tombstone} */
    this.nodes = new Map();
    /** 树根（parent === null）的子节点 id 集合 */
    this.rootIds = new Set();
    /** 父 -> 子 id 集合 */
    this.children = new Map();
    /** 已应用的撤销 id 集合（幂等用） */
    this.undos = new Set();
    /** 全局投递次序（仅用于排查，不影响收敛顺序） */
    this._counter = 0;
    /** 应用计数（断言“仅应用一次”） */
    this.applyCount = 0;
    /**
     * 审计台账：每一次被拒的“信封级投递”（畸形/越界/复用标识篡改载荷）。
     * 坏数据包只被丢弃、不改操作生命周期——之后到达的规范投递仍可生效；
     * 但拒因永远留痕，便于“定位首个拒因”。
     */
    this.refusedDeliveries = [];
  }

  // 拒绝一个坏信封：只入审计台账并占用一个全局次序，绝不改状态机与投影。
  _refuse(id, reason) {
    this.refusedDeliveries.push({ id, reason, order: ++this._counter });
  }

  // ---- 生成：登记规范信封，不改变投影 -------------------------------
  // hold=true 表示生成后滞留（不立即投递，模拟乱序/离线）
  gen(env, { hold = false } = {}) {
    const norm = normalizeEnvelope(env);
    if (norm.error) {
      // 生成即非法：记录拒因，绝不登记
      this.state.set(env && isNonEmptyString(env.id) ? env.id : `malformed#${this._counter + 1}`, {
        status: STATUS.REJECTED,
        order: ++this._counter,
        envelope: env ?? null,
        reason: norm.error
      });
      return { ok: false, reason: norm.error };
    }
    const e = norm.value;
    if (this.records.has(e.id)) {
      return { ok: false, reason: REASON.ALREADY };
    }
    this.records.set(e.id, deepFreeze(JSON.parse(JSON.stringify(e))));
    if (!hold) this.deliver(e.id);
    return { ok: true, id: e.id };
  }

  // 置 REJECTED 后必须级联：等待它的子项可能就此定格为硬拒因，不能永久挂起
  _reject(id, envelope, reason) {
    this.state.set(id, { status: STATUS.REJECTED, order: ++this._counter, envelope, reason });
    this._cascade();
    return { ok: false, reason };
  }

  // ---- 投递 ---------------------------------------------------------
  deliver(id, envelopeOverride) {
    if (!isNonEmptyString(id)) return { ok: false, reason: REASON.MALFORMED };

    // 幂等：已应用/已拒且本次“未携带信封”的重复投递直接返回，不新增任何步骤或墓碑。
    // 若携带了信封（可能是复用标识的篡改投递），必须先走篡改比对，不能被幂等短路。
    const prev = this.state.get(id);
    const carriesEnvelope = envelopeOverride !== undefined;
    if (!carriesEnvelope && prev && (prev.status === STATUS.APPLIED || prev.status === STATUS.REJECTED)) {
      return { ok: prev.status === STATUS.APPLIED, reason: prev.status === STATUS.APPLIED ? REASON.ALREADY : prev.reason, duplicate: true };
    }
    if (!carriesEnvelope && prev && prev.status === STATUS.WAITING) {
      // 同一等待信封的无信封再次投递：仍为等待，不重复计数
      return { ok: false, reason: '等待依赖齐备', waiting: true, duplicate: true };
    }

    // 信封来源：显式携带（可能篡改）> 已生成规范
    let envelope = envelopeOverride;
    if (envelope === undefined) {
      envelope = this.records.get(id) ?? null;
      if (!envelope) {
        this.state.set(id, { status: STATUS.MISSING, order: ++this._counter, envelope: null, reason: REASON.MISSING_OP });
        return { ok: false, reason: REASON.MISSING_OP };
      }
    } else {
      const norm = normalizeEnvelope(envelope);
      if (norm.error) {
        // 坏信封（畸形/越界序号）：丢弃该数据包，状态机不变，只留审计
        this._refuse(id, norm.error);
        return { ok: false, reason: norm.error };
      }
      envelope = norm.value;
      if (envelope.id !== id) {
        this._refuse(id, REASON.MALFORMED);
        return { ok: false, reason: REASON.MALFORMED };
      }
      const canon = this.records.get(id);
      if (!canon) {
        // 未生成直接携带信封：缺失操作记录
        this._refuse(id, REASON.MISSING_OP);
        return { ok: false, reason: REASON.MISSING_OP };
      }
      // 复用操作标识但篡改载荷：丢弃该数据包；状态机保持原状（之后规范投递仍可生效）
      if (JSON.stringify(canon) !== JSON.stringify(envelope)) {
        this._refuse(id, REASON.PAYLOAD_TAMPERED);
        return { ok: false, reason: REASON.PAYLOAD_TAMPERED };
      }
      // 携带信封与规范一致：等价于一次规范投递，继续走下方依赖/幂等路径
    }

    // 依赖检查（乱序等待 vs 硬拒因）
    const blocker = this._dependencyBlocker(envelope);
    if (blocker === 'wait') {
      this.state.set(id, { status: STATUS.WAITING, order: prev ? prev.order : ++this._counter, envelope, reason: '等待父项依赖' });
      return { ok: false, reason: '等待父项依赖', waiting: true };
    }
    if (blocker) return this._reject(id, envelope, blocker);

    // 携带“与规范一致”的信封重投已应用操作：仍按幂等处理，不再次应用
    if (prev?.status === STATUS.APPLIED) {
      return { ok: true, reason: REASON.ALREADY, duplicate: true };
    }

    this._apply(envelope);
    this.state.set(id, { status: STATUS.APPLIED, order: prev ? prev.order : ++this._counter, envelope });
    // 级联刷新：依赖刚刚齐备的等待项（仍只应用一次）
    this._cascade();
    return { ok: true, id };
  }

  // null  => 可应用；'wait' => 依赖尚未出现（等待）；字符串 => 硬拒因
  _dependencyBlocker(env) {
    if (env.op === OP.INSERT) {
      const parent = env.payload.parent;
      if (parent === null) return null;
      if (!this.records.has(parent)) return REASON.PARENT_MISSING;
      const ps = this.state.get(parent);
      if (!ps || ps.status === STATUS.MISSING) return 'wait';
      if (ps.status === STATUS.WAITING || ps.status === STATUS.READY) return 'wait';
      if (ps.status === STATUS.REJECTED) return REASON.PARENT_MISSING;
      const node = this.nodes.get(parent);
      if (!node) return 'wait'; // 已应用但节点未落树（保守等待，理论上不可达）
      // 父项即便已是墓碑，合法子步骤仍须应用并出现在正确位置（不株连、不拒受）
      return null;
    }

    // undo：目标是另一个步骤
    const target = env.payload.target;
    if (!this.records.has(target)) return REASON.TARGET_MISSING;
    const ts = this.state.get(target);
    if (!ts || ts.status === STATUS.MISSING) return 'wait';
    if (ts.status === STATUS.WAITING || ts.status === STATUS.READY) return 'wait';
    if (ts.status === STATUS.REJECTED) return REASON.TARGET_MISSING;
    if (!this.nodes.has(target)) return 'wait';
    return null;
  }

  _apply(env) {
    this.applyCount++;
    if (env.op === OP.INSERT) {
      const { label, parent, seq, note } = env.payload;
      this.nodes.set(env.id, { id: env.id, label, parent, seq, note, tombstone: false });
      if (parent === null) this.rootIds.add(env.id);
      else {
        if (!this.children.has(parent)) this.children.set(parent, new Set());
        this.children.get(parent).add(env.id);
      }
    } else {
      const node = this.nodes.get(env.payload.target);
      if (node) node.tombstone = true;
      this.undos.add(env.id);
    }
  }

  _cascade() {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const [id, st] of this.state) {
        if (st.status !== STATUS.WAITING) continue;
        const blocker = this._dependencyBlocker(st.envelope);
        if (blocker === null) {
          this._apply(st.envelope);
          st.status = STATUS.APPLIED;
          progressed = true;
        } else if (blocker !== 'wait') {
          // 等待期间依赖变成硬拒（如父被撤销）：定格为拒因，投影不留半截
          st.status = STATUS.REJECTED;
          st.reason = blocker;
          progressed = true;
        }
      }
    }
  }

  // ---- 投影：稳定操作标识排序的先序序列 -----------------------------
  _orderedChildren(parentId) {
    const set = parentId === null ? this.rootIds : this.children.get(parentId);
    return set ? [...set].sort(compareId) : [];
  }

  // 全量树（含墓碑；墓碑祖先的后代仍挂在原位，只是默认不可见）
  tree() {
    const build = (parentId) =>
      this._orderedChildren(parentId).map((id) => {
        const n = this.nodes.get(id);
        return { ...n, children: build(id) };
      });
    return build(null);
  }

  // 可见步骤：墓碑元素自身不可见，但撤销不株连——
  // 即使父/祖先已撤销，合法子步骤仍沿树下钻出现在正确位置（以 underTombstone 标注）。
  visibleSequence() {
    const out = [];
    let index = 0;
    const walk = (parentId, tombstoneAncestors) => {
      for (const id of this._orderedChildren(parentId)) {
        const n = this.nodes.get(id);
        const underTombstone = tombstoneAncestors.length > 0;
        if (!n.tombstone) {
          out.push({
            index: index++,
            id: n.id,
            label: n.label,
            seq: n.seq,
            note: n.note,
            parent: n.parent,
            underTombstone,
            tombstoneAncestors: underTombstone ? [...tombstoneAncestors] : [],
            visible: true
          });
        }
        walk(id, n.tombstone ? [...tombstoneAncestors, id] : tombstoneAncestors);
      }
    };
    walk(null, []);
    return out;
  }

  // 供页面逐项回放：每一步的可见项/等待/墓碑/首个拒因
  snapshot() {
    const seq = this.visibleSequence();
    const waiting = [];
    const rejected = [];
    for (const [id, st] of this.state) {
      if (st.status === STATUS.WAITING) waiting.push({ id, reason: st.reason || '等待父项依赖' });
      if (st.status === STATUS.REJECTED) rejected.push({ id, reason: st.reason, order: st.order });
    }
    // 对已应用操作的篡改/畸形重投不进状态机，但同样是定位对象
    for (const r of this.refusedDeliveries) rejected.push({ id: r.id, reason: r.reason, order: r.order });
    waiting.sort((a, b) => compareId(a.id, b.id));
    rejected.sort((a, b) => a.order - b.order);
    return {
      name: this.name,
      sequence: seq,
      visible: seq,
      underTombstone: seq.filter((s) => s.underTombstone),
      tombstones: [...this.nodes.values()].filter((n) => n.tombstone).map((n) => n.id).sort(compareId),
      waiting,
      firstReject: rejected[0] ?? null,
      rejected,
      applied: [...this.nodes.keys()].filter((id) => {
        const st = this.state.get(id);
        return st && st.status === STATUS.APPLIED;
      }).sort(compareId).concat([...this.undos].sort(compareId)),
      applyCount: this.applyCount
    };
  }

  // ---- 序列化 / 恢复 -------------------------------------------------
  toJSON() {
    return {
      name: this.name,
      records: [...this.records.entries()],
      state: [...this.state.entries()].map(([id, st]) => [id, { ...st }]),
      nodes: [...this.nodes.values()],
      rootIds: [...this.rootIds],
      children: [...this.children.entries()].map(([p, s]) => [p, [...s]]),
      undos: [...this.undos],
      refusedDeliveries: this.refusedDeliveries,
      _counter: this._counter,
      applyCount: this.applyCount
    };
  }

  static fromJSON(data) {
    const r = new Replica(data.name);
    r.records = new Map(data.records.map(([id, e]) => [id, deepFreeze(e)]));
    r.state = new Map(data.state.map(([id, st]) => [id, st]));
    r.nodes = new Map(data.nodes.map((n) => [n.id, n]));
    r.rootIds = new Set(data.rootIds);
    r.children = new Map(data.children.map(([p, s]) => [p, new Set(s)]));
    r.undos = new Set(data.undos);
    r._counter = data._counter;
    r.applyCount = data.applyCount;
    r.refusedDeliveries = data.refusedDeliveries ?? [];
    return r;
  }
}

// 运行一整份演练单：lines 为 [{m:'gen'|'deliver', id, env?, hold?}]
// 返回每步动作后的快照，供“按步骤回放”
export function runDrill(name, lines) {
  const r = new Replica(name);
  const frames = [];
  lines.forEach((line, i) => {
    let result;
    if (line.m === 'gen') result = r.gen(line.env, { hold: !!line.hold });
    else result = r.deliver(line.id, line.env);
    frames.push({ step: i + 1, line, result, snapshot: r.snapshot() });
  });
  return { replica: r, frames };
}
