// Manager worker. All oxidd operations happen here.
// We import the wasm-bindgen glue as an ES module.

import init, { initThreadPool, setPanicHook, BDDManager } from "./pkg/oxidd_wasm.js";

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
  mgrVar({ mgr, varNo }) {
    return register(get(mgr).var(varNo));
  },
  mgrTrue({ mgr }) {
    return register(get(mgr).true_());
  },
  mgrFalse({ mgr }) {
    return register(get(mgr).false_());
  },

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

  // --- BDD queries (return plain values) ---
  bddSatisfiable({ a })        { return get(a).satisfiable(); },
  bddValid({ a })              { return get(a).valid(); },
  bddSatCount({ a, numVars })  { return get(a).sat_count(numVars); },
  bddNodeCount({ a })          { return get(a).node_count(); },

  // --- Handle management ---
  free({ h }) { free(h); return true; },
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
