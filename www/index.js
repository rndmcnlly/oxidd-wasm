// Main thread: UI + RPC client. No WASM here.

const log = (msg) => {
  const out = document.getElementById("output");
  out.textContent += msg + "\n";
};

const logError = (msg) => {
  document.getElementById("output").innerHTML += `\n<span class="error">${msg}</span>`;
};

// --- RPC client ---
class OxiddClient {
  constructor(workerUrl = "./manager-worker.js") {
    this.worker = new Worker(workerUrl, { type: "module" });
    this.pending = new Map();
    this.nextId = 1;
    this.loaded = new Promise((resolve) => (this._resolveLoaded = resolve));
    this.worker.addEventListener("message", (ev) => this._onMessage(ev));
    this.worker.addEventListener("error", (ev) => {
      logError(`Worker error: ${ev.message} (${ev.filename}:${ev.lineno})`);
      console.error(ev);
    });
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

  async init() {
    await this.loaded;
    return this.call("__init__", {});
  }

  // --- Manager construction returns a Manager facade ---
  async newManager(innerCap, cacheCap) {
    const mgr = await this.call("mgrNew", { innerCap, cacheCap, threads: 1 });
    return new Manager(this, mgr);
  }
}

class Manager {
  constructor(client, handle) {
    this.c = client;
    this.h = handle;
  }

  async addVars(n)        { return this.c.call("mgrAddVars", { mgr: this.h, count: n }); }
  async numVars()         { return this.c.call("mgrNumVars", { mgr: this.h }); }
  async numInnerNodes()   { return this.c.call("mgrNumInnerNodes", { mgr: this.h }); }
  async gc()              { return this.c.call("mgrGc", { mgr: this.h }); }
  async var_(v)           { return new BDD(this.c, await this.c.call("mgrVar",   { mgr: this.h, varNo: v })); }
  async true_()           { return new BDD(this.c, await this.c.call("mgrTrue",  { mgr: this.h })); }
  async false_()          { return new BDD(this.c, await this.c.call("mgrFalse", { mgr: this.h })); }
}

class BDD {
  constructor(client, handle) {
    this.c = client;
    this.h = handle;
  }

  async not()             { return new BDD(this.c, await this.c.call("bddNot",   { a: this.h })); }
  async and(o)            { return new BDD(this.c, await this.c.call("bddAnd",   { a: this.h, b: o.h })); }
  async or(o)             { return new BDD(this.c, await this.c.call("bddOr",    { a: this.h, b: o.h })); }
  async xor(o)            { return new BDD(this.c, await this.c.call("bddXor",   { a: this.h, b: o.h })); }
  async nand(o)           { return new BDD(this.c, await this.c.call("bddNand",  { a: this.h, b: o.h })); }
  async nor(o)            { return new BDD(this.c, await this.c.call("bddNor",   { a: this.h, b: o.h })); }
  async imp(o)            { return new BDD(this.c, await this.c.call("bddImp",   { a: this.h, b: o.h })); }
  async equiv(o)          { return new BDD(this.c, await this.c.call("bddEquiv", { a: this.h, b: o.h })); }
  async ite(t, e)         { return new BDD(this.c, await this.c.call("bddIte",   { i: this.h, t: t.h, e: e.h })); }
  async exists(vars)      { return new BDD(this.c, await this.c.call("bddExists",{ a: this.h, vars: vars.h })); }
  async forall(vars)      { return new BDD(this.c, await this.c.call("bddForall",{ a: this.h, vars: vars.h })); }
  async cofactorTrue()    { const h = await this.c.call("bddCofactorTrue",  { a: this.h }); return h ? new BDD(this.c, h) : null; }
  async cofactorFalse()   { const h = await this.c.call("bddCofactorFalse", { a: this.h }); return h ? new BDD(this.c, h) : null; }

  async satisfiable()        { return this.c.call("bddSatisfiable", { a: this.h }); }
  async valid()              { return this.c.call("bddValid",       { a: this.h }); }
  async satCount(numVars)    { return this.c.call("bddSatCount",    { a: this.h, numVars }); }
  async nodeCount()          { return this.c.call("bddNodeCount",   { a: this.h }); }
}

// --- Demo ---
async function main() {
  log("Spawning manager worker...");
  const client = new OxiddClient();
  await client.loaded;
  log("Worker loaded.");

  log(`Initializing...`);
  await client.init();
  log(`Worker ready (single-threaded wasm)`);

  log("\n--- BDD Demo: (x0 AND x1) OR x2 ---\n");
  const mgr = await client.newManager(65536, 65536);
  log(`Created BDDManager`);

  const vars = await mgr.addVars(3);
  log(`Added variables: ${vars}`);

  const x0 = await mgr.var_(vars[0]);
  const x1 = await mgr.var_(vars[1]);
  const x2 = await mgr.var_(vars[2]);

  const x0x1 = await x0.and(x1);
  const result = await x0x1.or(x2);

  log(`satisfiable: ${await result.satisfiable()}`);
  log(`valid:       ${await result.valid()}`);
  log(`sat count:   ${await result.satCount(3)}`);
  log(`node count:  ${await result.nodeCount()}`);
  log(`inner nodes: ${await mgr.numInnerNodes()}`);

  log("\n--- N-queens (n=8) via BDD ---\n");
  const n = 8;
  const qmgr = await client.newManager(1 << 22, 1 << 20);
  const qvarsFlat = await qmgr.addVars(n * n);

  const idx = (r, c) => r * n + c;
  const qvar = (r, c) => qmgr.var_(qvarsFlat[idx(r, c)]);

  let queens = await qmgr.true_();

  const t0 = performance.now();
  for (let row = 0; row < n; row++) {
    let rowBdd = await qmgr.false_();
    for (let col = 0; col < n; col++) {
      let queen = await qvar(row, col);
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (r === row && c === col) continue;
          if (r === row || c === col || r - c === row - col || r + c === row + col) {
            const v = await qvar(r, c);
            const vn = await v.not();
            queen = await queen.and(vn);
          }
        }
      }
      rowBdd = await rowBdd.or(queen);
    }
    queens = await queens.and(rowBdd);
    log(`row ${row}: sat=${await queens.satisfiable()}, nodes=${await qmgr.numInnerNodes()}`);
  }
  const t1 = performance.now();

  log(`\n8-queens solutions: ${await queens.satCount(n * n)}`);
  log(`(expected: 92)`);
  log(`elapsed: ${(t1 - t0).toFixed(0)}ms`);
}

main().catch((e) => {
  logError(`Error: ${e.message || e}`);
  console.error(e);
});
