// Manager worker. All oxidd operations happen here.
// We import the wasm-bindgen glue as an ES module.

import init, { initThreadPool, setPanicHook, BDDManager, SubstitutionBuilder, CommandBuffer } from "./pkg/oxidd_wasm.js";

// Object registry: maps handle id -> live Rust object (BDDManager or BDD).
// Handles are small integers that main thread uses to refer to Rust objects.
const objects = new Map();
let nextHandle = 1;

function register(obj) {
  const h = nextHandle++;
  objects.set(h, obj);
  return h;
}

function get(h) {
  const obj = objects.get(h);
  if (!obj) throw new Error(`invalid handle: ${h}`);
  return obj;
}

function free(h) {
  const obj = objects.get(h);
  if (obj) {
    objects.delete(h);
    if (typeof obj.free === "function") obj.free();
  }
}

// RPC dispatch table. Each entry is (args) => result (sync, throws on error).
// For BDD ops that return a new BDD, we register it and return its handle.
const dispatch = {
  // --- Manager lifecycle ---
  mgrNew({ innerCap, cacheCap, threads }) {
    return register(new BDDManager(innerCap, cacheCap, threads));
  },
  mgrAddVars({ mgr, count }) {
    return Array.from(get(mgr).add_vars(count));
  },
  mgrNumVars({ mgr }) {
    return get(mgr).num_vars();
  },
  mgrNumInnerNodes({ mgr }) {
    return get(mgr).num_inner_nodes();
  },
  mgrGc({ mgr }) {
    return get(mgr).gc();
  },
  mgrSplitDepth({ mgr }) {
    return get(mgr).split_depth();
  },
  mgrSetSplitDepth({ mgr, depth }) {
    // `depth` is null (for oxidd default) or a u32 (including 0 to disable parallelism).
    get(mgr).set_split_depth(depth === null ? undefined : depth);
    return true;
  },
  mgrVar({ mgr, varNo }) {
    return register(get(mgr).var(varNo));
  },
  mgrTrue({ mgr }) {
    return register(get(mgr).true_());
  },
  mgrFalse({ mgr }) {
    return register(get(mgr).false_());
  },

  // Build cube of literals: polarity 1 = positive, 0 = negated.
  // One FFI call replacing N ands + not_vars from JS.
  mgrCube({ mgr, varNos, polarities }) {
    const v = new Uint32Array(varNos);
    const p = new Uint8Array(polarities);
    return register(get(mgr).cube(v, p));
  },

  // --- CommandBuffer lifecycle (graphics-API-style batched submit) ---
  // See lib.rs for wire format details. Usage pattern from JS:
  //   const cb = call("cbNew")
  //   const bindIdx = call("cbBind", { cb, bdd: someHandle })
  //   call("cbSetProgram", { cb, ops, a, b, c, outputs })
  //   const handles = call("cbSubmit", { mgr, cb })
  //   call("free", { h: cb })   // or drop via FinalizationRegistry
  cbNew() {
    return register(new CommandBuffer());
  },
  cbBind({ cb, bdd }) {
    return get(cb).bind_bdd(get(bdd));
  },
  cbBindSubst({ cb, subst }) {
    return get(cb).bind_subst(get(subst));
  },
  cbSetProgram({ cb, ops, a, b, c, outputs }) {
    get(cb).set_program(
      new Uint8Array(ops),
      new Uint32Array(a),
      new Uint32Array(b),
      new Uint32Array(c),
      new Uint32Array(outputs),
    );
    return true;
  },
  cbLen({ cb }) {
    return get(cb).len();
  },
  cbSubmit({ mgr, cb }) {
    // Returns an array of BDDs; register each and return the handle list.
    const results = get(mgr).submit(get(cb));
    return results.map((bdd) => register(bdd));
  },

  // Substitution builder lifecycle.
  mgrNewSubstBuilder({ mgr }) {
    return register(get(mgr).new_substitution_builder());
  },
  substAdd({ builder, varNo, bdd }) {
    get(builder).add(varNo, get(bdd));
    return true;
  },
  substBuild({ builder }) {
    // SubstitutionBuilder.build() consumes the builder; wasm-bindgen moves it.
    // After this the builder handle is invalid; we drop it from our map too.
    const b = get(builder);
    const subst = b.build();
    objects.delete(builder);
    return register(subst);
  },
  substVarCount({ subst }) { return get(subst).var_count(); },

  // --- BDD ops (each returns new handle) ---
  bddNot({ a })          { return register(get(a).not()); },
  bddAnd({ a, b })       { return register(get(a).and(get(b))); },
  bddOr({ a, b })        { return register(get(a).or(get(b))); },
  bddXor({ a, b })       { return register(get(a).xor(get(b))); },
  bddNand({ a, b })      { return register(get(a).nand(get(b))); },
  bddNor({ a, b })       { return register(get(a).nor(get(b))); },
  bddImp({ a, b })       { return register(get(a).imp(get(b))); },
  bddEquiv({ a, b })     { return register(get(a).equiv(get(b))); },
  bddIte({ i, t, e })    { return register(get(i).ite(get(t), get(e))); },
  bddExists({ a, vars }) { return register(get(a).exists(get(vars))); },
  bddForall({ a, vars }) { return register(get(a).forall(get(vars))); },
  bddCofactorTrue({ a })  { const r = get(a).cofactor_true();  return r ? register(r) : null; },
  bddCofactorFalse({ a }) { const r = get(a).cofactor_false(); return r ? register(r) : null; },

  // New compound ops (see lib.rs for semantics).
  bddSubstitute({ a, subst })       { return register(get(a).substitute(get(subst))); },
  bddImage({ s, trans, qvars, subst })    { return register(get(s).image(get(trans), get(qvars), get(subst))); },
  bddPreimage({ s, trans, qvars, subst }) { return register(get(s).preimage(get(trans), get(qvars), get(subst))); },

  // --- BDD queries (return plain values) ---
  bddSatisfiable({ a })        { return get(a).satisfiable(); },
  bddValid({ a })              { return get(a).valid(); },
  bddEquals({ a, b })          { return get(a).equals(get(b)); },
  bddSatCount({ a, numVars })  { return get(a).sat_count(numVars); },
  bddCountWithNvars({ a, nCare, total }) { return get(a).count_with_nvars(nCare, total); },
  bddNodeCount({ a })          { return get(a).node_count(); },
  // Support returns a Uint32Array-compatible array of var numbers.
  bddSupport({ a })            { return Array.from(get(a).support()); },
  // pick_cube returns Int8Array: -1 don't-care, 0 false, 1 true.
  // Empty array means unsat.
  bddPickCube({ a })           { return Array.from(get(a).pick_cube()); },

  // --- Handle management ---
  // Single-handle free, kept for backward compat.
  free({ h }) { free(h); return true; },
  // Batch free, called by FinalizationRegistry cleanup. Accepts handles
  // array; silently skips unknown handles (the registry can race with
  // explicit frees).
  freeMany({ handles }) {
    for (const h of handles) {
      const obj = objects.get(h);
      if (obj) {
        objects.delete(h);
        if (typeof obj.free === "function") obj.free();
      }
    }
    return handles.length;
  },
  // Debug: current live handle count.
  liveCount() { return objects.size; },
};

let ready = false;
let pendingInit = null;

async function bootstrap(numThreads) {
  await init();
  setPanicHook();
  await initThreadPool(numThreads);
  ready = true;
}

self.addEventListener("message", async (ev) => {
  const { id, method, args } = ev.data;
  try {
    if (method === "__init__") {
      pendingInit = bootstrap(args.numThreads);
      await pendingInit;
      self.postMessage({ id, ok: true, result: { numThreads: args.numThreads } });
      return;
    }
    if (!ready) {
      if (pendingInit) await pendingInit;
      else throw new Error("worker not initialized; call __init__ first");
    }
    const fn = dispatch[method];
    if (!fn) throw new Error(`unknown method: ${method}`);
    const result = fn(args);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.stack ? err.stack : err) });
  }
});

self.postMessage({ type: "worker_loaded" });
