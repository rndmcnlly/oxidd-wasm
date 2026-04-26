// iota.js - Typed symbolic-programming layer over oxidd-wasm.
//
// Inspired by omega.symbolic.fol (https://github.com/tulip-control/omega):
// the valuable abstraction is TYPED expressions over integers and booleans,
// with a primed/unprimed distinction for transition systems. The BDD
// manager is interchangeable plumbing underneath.
//
// -- Batched execution model --
//
// The critical performance property of this API is that building an
// expression is ZERO FFI hops. `ctx.mul("x", "y")` doesn't call the
// worker at all: it returns an IR node synchronously. BDDs are only
// materialized when you call `ctx.evaluate([...])`, which serializes
// the whole IR graph into a CommandBuffer and submits it in one
// postMessage.
//
// This mirrors the evolution of graphics APIs from immediate-mode GL
// calls (one round-trip per primitive, caller-bottlenecked) to command
// buffers (Vulkan, Metal, D3D12): the engine receives the whole frame's
// work and hides the boundary latency.  Our "frames" are algebraic
// expressions; our "GPU" is oxidd in a single Web Worker.
//
// Division of labor:
//   - JS side (this file): typed variable declaration, bitblaster that
//     emits IR, fixpoint loops.
//   - Rust side (oxidd-wasm/src/lib.rs): CommandBuffer executor that
//     walks the IR once, calls oxidd, and materializes only the caller's
//     requested outputs.
//
// There's no worker pool: a Client owns exactly one Web Worker, which
// owns one Wasm module instance. Parallel rayon execution inside Wasm
// did not produce speedup on browser workloads (see README's postmortem);
// removing it dropped the SharedArrayBuffer / crossOriginIsolated /
// nightly-Rust requirements.

// ---------------------------------------------------------------------------
// RPC client
// ---------------------------------------------------------------------------

export class Client {
  constructor(workerUrl = "./manager-worker.js") {
    this.worker = new Worker(workerUrl, { type: "module" });
    this.pending = new Map();
    this.nextId = 1;
    this.loaded = new Promise((resolve) => (this._resolveLoaded = resolve));
    this.worker.addEventListener("message", (ev) => this._onMessage(ev));
    this.worker.addEventListener("error", (ev) => {
      // eslint-disable-next-line no-console
      console.error("iota worker error:", ev);
    });

    this._freeQueue = [];
    this._freeFlushScheduled = false;
    this._registry = new FinalizationRegistry((h) => this._enqueueFree(h));
  }

  _onMessage(ev) {
    const msg = ev.data;
    if (msg && msg.type === "worker_loaded") {
      this._resolveLoaded();
      return;
    }
    const { id, ok, result, error } = msg;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (ok) pending.resolve(result);
    else pending.reject(new Error(error));
  }

  call(method, args) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, args });
    });
  }

  /// Initialize the worker's Wasm module. The `_numThreads` parameter
  /// is accepted for backward compatibility but ignored; the worker
  /// always runs single-threaded.
  async init(_numThreads) {
    await this.loaded;
    return this.call("__init__", {});
  }

  _enqueueFree(handle) {
    this._freeQueue.push(handle);
    if (!this._freeFlushScheduled) {
      this._freeFlushScheduled = true;
      queueMicrotask(() => this._flushFrees());
    }
  }

  _flushFrees() {
    this._freeFlushScheduled = false;
    if (this._freeQueue.length === 0) return;
    const batch = this._freeQueue;
    this._freeQueue = [];
    this.worker.postMessage({ id: this.nextId++, method: "freeMany", args: { handles: batch } });
  }

  register(obj, handle) {
    this._registry.register(obj, handle);
  }

  /// Tear down the worker and its Wasm instance. Releases all
  /// linear-memory pages the worker had grown; a subsequent
  /// `new Client()` starts from a fresh Wasm instance. This is the
  /// only reliable way to shrink Wasm memory in the browser, since
  /// dropping a manager frees slots in the node table but never
  /// shrinks the memory pages that back it.
  terminate() {
    try { this.worker.terminate(); } catch (_) { /* already dead */ }
    for (const { reject } of this.pending.values()) {
      reject(new Error("Client terminated"));
    }
    this.pending.clear();
  }
}

// ---------------------------------------------------------------------------
// BDD wrapper: owns a handle, auto-frees via FinalizationRegistry.
// ---------------------------------------------------------------------------

function wrapBdd(client, handle) {
  const b = new BDD(client, handle);
  client.register(b, handle);
  return b;
}

export class BDD {
  constructor(client, handle) {
    this._c = client;
    this._h = handle;
  }

  get handle() { return this._h; }

  async satisfiable()   { return this._c.call("bddSatisfiable", { a: this._h }); }
  async valid()         { return this._c.call("bddValid",       { a: this._h }); }
  async isEqual(o)      { return this._c.call("bddEquals",      { a: this._h, b: o._h }); }
  async satCount(numVars) { return this._c.call("bddSatCount",  { a: this._h, numVars }); }
  async nodeCount()     { return this._c.call("bddNodeCount",   { a: this._h }); }
  async support()       { return this._c.call("bddSupport",     { a: this._h }); }
  async pickCube()      { return this._c.call("bddPickCube",    { a: this._h }); }

  // Pairwise ops for convenience when the user wants a one-off combination
  // outside of a batch. These cost one RPC each; prefer `ctx.evaluate` for
  // building up expressions.
  async and(o) { return wrapBdd(this._c, await this._c.call("bddAnd", { a: this._h, b: o._h })); }
  async or(o)  { return wrapBdd(this._c, await this._c.call("bddOr",  { a: this._h, b: o._h })); }
  async not()  { return wrapBdd(this._c, await this._c.call("bddNot", { a: this._h })); }
}

// ---------------------------------------------------------------------------
// Substitution: opaque handle; built via Context.buildSubst().
// ---------------------------------------------------------------------------

export class Substitution {
  constructor(client, handle) { this._c = client; this._h = handle; }
}

// ---------------------------------------------------------------------------
// Expression IR
//
// Expressions are plain JS objects with a kind tag and child references.
// Shared subexpressions are literally the same object; evaluate() uses
// identity to do CSE when lowering to the CommandBuffer.
// ---------------------------------------------------------------------------

// Opcode constants mirror lib.rs::op::*.
const OP = {
  TRUE:   0x00,
  FALSE:  0x01,
  VAR:    0x02,
  BIND:   0x03,
  NOT:    0x10,
  AND:    0x11,
  OR:     0x12,
  XOR:    0x13,
  IMP:    0x14,
  EQUIV:  0x15,
  ITE:    0x16,
  EXISTS: 0x20,
  FORALL: 0x21,
  SUBST:  0x22,
};

// Expression-node factories. Each returns an IR node object.
// { op, a, b, c } where a/b/c are either IR nodes (for computed ops) or
// primitive payloads (VAR stores a varNo, BIND stores a BDD instance,
// SUBST stores a Substitution for b).
function n(op, a = null, b = null, c = null) {
  return { op, a, b, c };
}

// Canonical singletons for constants. Same identity everywhere => single
// opcode slot in every batch.
const E_TRUE  = n(OP.TRUE);
const E_FALSE = n(OP.FALSE);

// Per-var cache is kept on the Context.

// ---------------------------------------------------------------------------
// Typed variable descriptors
// ---------------------------------------------------------------------------

class UintVar {
  constructor(name, bits, bitVarNos) {
    this.name = name;
    this.kind = "uint";
    this.bits = bits;
    this.bitVarNos = bitVarNos;
  }
}

class BoolVarT {
  constructor(name, varNo) {
    this.name = name;
    this.kind = "bool";
    this.varNo = varNo;
  }
}

// ---------------------------------------------------------------------------
// Context: the user-facing symbolic-programming interface.
// ---------------------------------------------------------------------------

export class Context {
  constructor(client, mgrHandle) {
    this._c = client;
    this._mgr = mgrHandle;
    this._vars = new Map();
    this._primed = new Map();

    // Cache IR nodes for variables so shared subexpressions compress in
    // the command buffer.
    this._varNodeCache = new Map();  // varNo -> IR node

    this.T = E_TRUE;
    this.F = E_FALSE;
  }

  static async create({
    innerCap = 1 << 22,
    cacheCap = 1 << 20,
  } = {}) {
    const client = new Client();
    await client.loaded;
    await client.init();
    return Context.fromClient(client, { innerCap, cacheCap });
  }

  static async fromClient(client, { innerCap = 1 << 22, cacheCap = 1 << 20 } = {}) {
    const mgr = await client.call("mgrNew", { innerCap, cacheCap, threads: 1 });
    return new Context(client, mgr);
  }

  /// Release the BDD manager this context owns. After calling this, the
  /// context is unusable. Any BDDs created through the context remain
  /// valid only until the next GC on the worker — dropping the manager
  /// releases its underlying node table.
  async close() {
    await this._c.call("free", { h: this._mgr });
    this._mgr = -1;
  }

  async numVars() { return this._c.call("mgrNumVars", { mgr: this._mgr }); }
  async numInnerNodes() { return this._c.call("mgrNumInnerNodes", { mgr: this._mgr }); }
  async gc() { return this._c.call("mgrGc", { mgr: this._mgr }); }

  // -- Declaration ----------------------------------------------------------

  async declareUint(name, bits) {
    if (this._vars.has(name)) throw new Error(`already declared: ${name}`);
    const varNos = await this._c.call("mgrAddVars", { mgr: this._mgr, count: bits });
    const v = new UintVar(name, bits, varNos);
    this._vars.set(name, v);
    return v;
  }

  async declareBool(name) {
    if (this._vars.has(name)) throw new Error(`already declared: ${name}`);
    const [varNo] = await this._c.call("mgrAddVars", { mgr: this._mgr, count: 1 });
    const v = new BoolVarT(name, varNo);
    this._vars.set(name, v);
    return v;
  }

  async declarePrimed(names) {
    const out = [];
    for (const name of names) {
      const orig = this._vars.get(name);
      if (!orig) throw new Error(`no such variable to prime: ${name}`);
      const primedName = name + "'";
      if (this._vars.has(primedName)) throw new Error(`already declared: ${primedName}`);
      let primed;
      if (orig.kind === "uint") {
        const varNos = await this._c.call("mgrAddVars", { mgr: this._mgr, count: orig.bits });
        primed = new UintVar(primedName, orig.bits, varNos);
      } else {
        const [varNo] = await this._c.call("mgrAddVars", { mgr: this._mgr, count: 1 });
        primed = new BoolVarT(primedName, varNo);
      }
      this._vars.set(primedName, primed);
      this._primed.set(name, primed);
      out.push(primed);
    }
    return out;
  }

  getVar(name) {
    const v = this._vars.get(name);
    if (!v) throw new Error(`unknown variable: ${name}`);
    return v;
  }

  // -- IR builders (ALL SYNCHRONOUS) ---------------------------------------
  //
  // These return IR nodes, not BDDs. No FFI hops. Reuse is by identity:
  // if the caller passes the same sub-expression twice, evaluate() emits
  // the opcode only once.

  /// IR node for bool variable `name`.
  bool(name) {
    const v = this.getVar(name);
    if (v.kind !== "bool") throw new Error(`${name} is not a bool`);
    return this._varNode(v.varNo);
  }

  /// Array of IR nodes (low bit first) for uint variable `name`.
  bits(name) {
    const v = this.getVar(name);
    if (v.kind !== "uint") throw new Error(`${name} is not a uint`);
    return v.bitVarNos.map((vn) => this._varNode(vn));
  }

  _varNode(varNo) {
    let node = this._varNodeCache.get(varNo);
    if (!node) {
      node = n(OP.VAR, varNo);
      this._varNodeCache.set(varNo, node);
    }
    return node;
  }

  /// Wrap an existing BDD as an IR leaf (BIND opcode).
  bind(bdd) {
    return n(OP.BIND, bdd);
  }

  // Boolean algebra.
  not(x)           { return n(OP.NOT, x); }
  and2(a, b)       { return n(OP.AND, a, b); }
  or2(a, b)        { return n(OP.OR, a, b); }
  xor(a, b)        { return n(OP.XOR, a, b); }
  imp(a, b)        { return n(OP.IMP, a, b); }
  equivBit(a, b)   { return n(OP.EQUIV, a, b); }
  ite(i, t, e)     { return n(OP.ITE, i, t, e); }
  exists(body, qvars) { return n(OP.EXISTS, body, qvars); }
  forall(body, qvars) { return n(OP.FORALL, body, qvars); }
  subst(body, substHandle) {
    if (!(substHandle instanceof Substitution)) {
      throw new Error("subst: second arg must be a Substitution");
    }
    return n(OP.SUBST, body, substHandle);
  }

  /// Variadic AND-fold. Shared subexpressions compress to a linear chain.
  and(...xs) {
    if (xs.length === 0) return this.T;
    let acc = xs[0];
    for (let i = 1; i < xs.length; i++) acc = this.and2(acc, xs[i]);
    return acc;
  }
  or(...xs) {
    if (xs.length === 0) return this.F;
    let acc = xs[0];
    for (let i = 1; i < xs.length; i++) acc = this.or2(acc, xs[i]);
    return acc;
  }

  // -- Bitvector bitblaster (builds IR only; zero FFI hops) -----------------

  /// Uint literal of `bits` bits. Returns array of T/F nodes (low bit first).
  uintLit(n_, bits) {
    const out = new Array(bits);
    for (let i = 0; i < bits; i++) out[i] = ((n_ >>> i) & 1) ? this.T : this.F;
    return out;
  }

  _asBits(e, bits) {
    if (typeof e === "string") {
      const v = this.getVar(e);
      if (v.kind !== "uint") throw new Error(`${e} is not a uint`);
      if (bits !== undefined && v.bits !== bits) {
        throw new Error(`uint ${e} has ${v.bits} bits, expected ${bits}`);
      }
      return this.bits(e);
    }
    if (Array.isArray(e)) return e;
    if (typeof e === "number") {
      if (bits === undefined) throw new Error("integer literal needs bit width context");
      return this.uintLit(e, bits);
    }
    throw new Error("cannot coerce to bits: " + typeof e);
  }

  _widthOf(e) {
    if (typeof e === "string") return this.getVar(e).bits;
    if (Array.isArray(e)) return e.length;
    return undefined;
  }

  _resolveWidth(a, b) {
    const wa = this._widthOf(a);
    const wb = this._widthOf(b);
    if (wa !== undefined && wb !== undefined && wa !== wb) {
      throw new Error(`bit-width mismatch: ${wa} vs ${wb}`);
    }
    const w = wa ?? wb;
    if (w === undefined) throw new Error("cannot infer bit width");
    return w;
  }

  // Full adder.  Note: we reuse the XOR of a,b so evaluate() folds it.
  _fullAdd(a, b, cin) {
    const axb = this.xor(a, b);
    const sum = this.xor(axb, cin);
    const cout = this.or2(this.and2(a, b), this.and2(cin, axb));
    return [sum, cout];
  }

  addBits(xs, ys) {
    if (xs.length !== ys.length) throw new Error("addBits: length mismatch");
    const out = new Array(xs.length);
    let carry = this.F;
    for (let i = 0; i < xs.length; i++) {
      const [s, c] = this._fullAdd(xs[i], ys[i], carry);
      out[i] = s;
      carry = c;
    }
    return out;
  }

  mulBits(xs, ys) {
    if (xs.length !== ys.length) throw new Error("mulBits: length mismatch");
    const k = xs.length;
    let acc = new Array(k).fill(this.F);
    for (let i = 0; i < k; i++) {
      const partial = new Array(k);
      for (let j = 0; j < k; j++) {
        partial[j] = j < i ? this.F : this.and2(xs[j - i], ys[i]);
      }
      acc = this.addBits(acc, partial);
    }
    return acc;
  }

  eqBits(xs, ys) {
    if (xs.length !== ys.length) throw new Error("eqBits: length mismatch");
    let acc = this.T;
    for (let i = 0; i < xs.length; i++) {
      acc = this.and2(acc, this.equivBit(xs[i], ys[i]));
    }
    return acc;
  }

  ltBits(xs, ys) {
    if (xs.length !== ys.length) throw new Error("ltBits: length mismatch");
    let lt = this.F;
    for (let i = xs.length - 1; i >= 0; i--) {
      const x = xs[i], y = ys[i];
      const onlyY = this.and2(this.not(x), y);
      const eq = this.equivBit(x, y);
      lt = this.or2(onlyY, this.and2(eq, lt));
    }
    return lt;
  }

  leBits(xs, ys) {
    return this.or2(this.ltBits(xs, ys), this.eqBits(xs, ys));
  }

  // High-level typed sugar.
  add(a, b) {
    const w = this._resolveWidth(a, b);
    return this.addBits(this._asBits(a, w), this._asBits(b, w));
  }
  mul(a, b) {
    const w = this._resolveWidth(a, b);
    return this.mulBits(this._asBits(a, w), this._asBits(b, w));
  }
  eq(a, b) {
    const w = this._resolveWidth(a, b);
    return this.eqBits(this._asBits(a, w), this._asBits(b, w));
  }
  lt(a, b) {
    const w = this._resolveWidth(a, b);
    return this.ltBits(this._asBits(a, w), this._asBits(b, w));
  }
  le(a, b) {
    const w = this._resolveWidth(a, b);
    return this.leBits(this._asBits(a, w), this._asBits(b, w));
  }

  // -- Quantifier-cube builders --------------------------------------------

  /// Build an IR expression representing the cube of variables `names`.
  qcube(names) {
    const lits = [];
    for (const nm of names) {
      const v = this.getVar(nm);
      if (v.kind === "uint") {
        for (const vn of v.bitVarNos) lits.push(this._varNode(vn));
      } else {
        lits.push(this._varNode(v.varNo));
      }
    }
    if (lits.length === 0) return this.T;
    let acc = lits[0];
    for (let i = 1; i < lits.length; i++) acc = this.and2(acc, lits[i]);
    return acc;
  }

  primedQcube(names) {
    return this.qcube(names.map((nm) => {
      const p = this._primed.get(nm);
      if (!p) throw new Error(`${nm} has no primed counterpart`);
      return p.name;
    }));
  }

  // -- Substitution (external handles; built eagerly with one round-trip) --

  /// Build a Substitution on the worker. Takes `pairs` as
  /// `[{ fromVarNo, toBdd }]`. Returns a Substitution (live handle).
  async buildSubst(pairs) {
    const builder = await this._c.call("mgrNewSubstBuilder", { mgr: this._mgr });
    for (const { fromVarNo, toBdd } of pairs) {
      await this._c.call("substAdd", { builder, varNo: fromVarNo, bdd: toBdd._h });
    }
    const h = await this._c.call("substBuild", { builder });
    const s = new Substitution(this._c, h);
    this._c.register(s, h);
    return s;
  }

  /// Substitution renaming primed `names` to unprimed counterparts.
  /// For each `n` in `names`: maps var `n'` to the BDD of variable `n`.
  async primedToUnprimed(names) {
    return this._renameSubst(names, (v) => this._primed.get(v.name), (v) => v);
  }

  /// Substitution renaming unprimed `names` to primed counterparts.
  /// For each `n`: maps var `n` to the BDD of variable `n'`.
  async unprimedToPrimed(names) {
    return this._renameSubst(names, (v) => v, (v) => this._primed.get(v.name));
  }

  async _renameSubst(names, fromSide, toSide) {
    // Materialize the target-side variables as BDDs in a single
    // CommandBuffer, then feed them into a Substitution builder.
    const targets = [];
    for (const nm of names) {
      const unprimed = this.getVar(nm);
      const fromVar = fromSide(unprimed);
      const toVar = toSide(unprimed);
      if (!fromVar || !toVar) throw new Error(`${nm} has no primed counterpart`);
      if (unprimed.kind === "uint") {
        for (let i = 0; i < unprimed.bits; i++) {
          targets.push({ fromVarNo: fromVar.bitVarNos[i], toVarNo: toVar.bitVarNos[i] });
        }
      } else {
        targets.push({ fromVarNo: fromVar.varNo, toVarNo: toVar.varNo });
      }
    }
    // One batch to produce all target-side var BDDs.
    const exprs = targets.map((t) => this._varNode(t.toVarNo));
    const handles = await this.evaluate(exprs);
    const pairs = targets.map((t, i) => ({ fromVarNo: t.fromVarNo, toBdd: handles[i] }));
    return this.buildSubst(pairs);
  }

  // -- Evaluation: lower an IR graph to a CommandBuffer and submit --------

  /// Evaluate `exprs` (array of IR nodes) and return one BDD per entry.
  /// This is the ONE ffi hop for an entire expression graph.
  async evaluate(exprs) {
    const batch = new CommandBuffer(this);
    const outputIdxs = exprs.map((e) => batch.emit(e));
    return batch.submit(outputIdxs);
  }

  /// Convenience for single-expression evaluation.
  async evaluate1(expr) {
    const [bdd] = await this.evaluate([expr]);
    return bdd;
  }

  // -- Cube decoding --------------------------------------------------------

  decodeCube(cube, names = null) {
    const out = {};
    const keys = names ?? [...this._vars.keys()];
    for (const name of keys) {
      const v = this._vars.get(name);
      if (!v) throw new Error(`unknown variable: ${name}`);
      if (v.kind === "bool") {
        out[name] = cube[v.varNo] === 1;
      } else {
        let m = 0;
        for (let i = 0; i < v.bits; i++) {
          if (cube[v.bitVarNos[i]] === 1) m |= (1 << i);
        }
        out[name] = m >>> 0;
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// CommandBuffer (JS side): collects opcodes and operands, submits once.
// ---------------------------------------------------------------------------

class CommandBuffer {
  constructor(ctx) {
    this._ctx = ctx;
    this._c = ctx._c;
    this._mgr = ctx._mgr;

    this.ops = [];
    this.a = [];
    this.b = [];
    this.c = [];

    // External bindings. Populated lazily when an expression references a
    // BDD or Substitution; the index is what goes into the opcode.
    this._bdds = [];         // list of BDDs
    this._bddIdx = new Map(); // BDD -> bind index
    this._substs = [];
    this._substIdx = new Map();

    // Memoization: IR node (by identity) -> instruction index.
    this._memo = new Map();
  }

  _emitRaw(op, a = 0, b = 0, c = 0) {
    const idx = this.ops.length;
    this.ops.push(op);
    this.a.push(a);
    this.b.push(b);
    this.c.push(c);
    return idx;
  }

  _bindBdd(bdd) {
    let idx = this._bddIdx.get(bdd);
    if (idx === undefined) {
      idx = this._bdds.length;
      this._bdds.push(bdd);
      this._bddIdx.set(bdd, idx);
    }
    return idx;
  }

  _bindSubst(s) {
    let idx = this._substIdx.get(s);
    if (idx === undefined) {
      idx = this._substs.length;
      this._substs.push(s);
      this._substIdx.set(s, idx);
    }
    return idx;
  }

  /// Emit an IR node and all its dependencies; return the instruction
  /// index. Uses identity-memoization so shared subexpressions are
  /// recorded exactly once.
  emit(node) {
    const cached = this._memo.get(node);
    if (cached !== undefined) return cached;

    let idx;
    switch (node.op) {
      case OP.TRUE:  idx = this._emitRaw(OP.TRUE);  break;
      case OP.FALSE: idx = this._emitRaw(OP.FALSE); break;
      case OP.VAR:   idx = this._emitRaw(OP.VAR, node.a); break;
      case OP.BIND: {
        const bi = this._bindBdd(node.a);
        idx = this._emitRaw(OP.BIND, bi);
        break;
      }
      case OP.NOT: {
        const ai = this.emit(node.a);
        idx = this._emitRaw(OP.NOT, ai);
        break;
      }
      case OP.AND: case OP.OR: case OP.XOR: case OP.IMP: case OP.EQUIV: {
        const ai = this.emit(node.a);
        const bi = this.emit(node.b);
        idx = this._emitRaw(node.op, ai, bi);
        break;
      }
      case OP.ITE: {
        const ai = this.emit(node.a);
        const bi = this.emit(node.b);
        const ci = this.emit(node.c);
        idx = this._emitRaw(OP.ITE, ai, bi, ci);
        break;
      }
      case OP.EXISTS: case OP.FORALL: {
        const ai = this.emit(node.a);
        const bi = this.emit(node.b);
        idx = this._emitRaw(node.op, ai, bi);
        break;
      }
      case OP.SUBST: {
        const ai = this.emit(node.a);
        const si = this._bindSubst(node.b);
        idx = this._emitRaw(OP.SUBST, ai, si);
        break;
      }
      default:
        throw new Error("emit: unknown IR op " + node.op);
    }
    this._memo.set(node, idx);
    return idx;
  }

  /// Submit the buffer to the worker. `outputIdxs` are instruction indices
  /// whose results should come back as persistent BDD handles.
  /// Returns Promise<BDD[]> with one BDD per outputIdx.
  async submit(outputIdxs) {
    // Allocate a CommandBuffer in the worker.
    const cb = await this._c.call("cbNew");
    // Bind external BDDs and substitutions up front. Order must match
    // the bind-indices we assigned in this._bdds / this._substs.
    for (const bdd of this._bdds) {
      await this._c.call("cbBind", { cb, bdd: bdd._h });
    }
    for (const s of this._substs) {
      await this._c.call("cbBindSubst", { cb, subst: s._h });
    }
    // Set the program. Use regular arrays; the worker converts to typed
    // arrays before passing to wasm.
    await this._c.call("cbSetProgram", {
      cb,
      ops: this.ops,
      a: this.a,
      b: this.b,
      c: this.c,
      outputs: outputIdxs,
    });
    // Fire the submission. Returns array of handles, one per output.
    const handles = await this._c.call("cbSubmit", { mgr: this._mgr, cb });
    // Drop the CB immediately.
    this._c.worker.postMessage({ id: this._c.nextId++, method: "freeMany", args: { handles: [cb] } });
    return handles.map((h) => wrapBdd(this._c, h));
  }
}
