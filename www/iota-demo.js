// iota-demo.js - exercise iota, showing the value of command-buffer batching.
//
// We build BDDs for the multiplication relation x * y = z at several
// widths, comparing:
//   (a) single-threaded
//   (b) multi-threaded
// and, more importantly, showing that without batching the multi-threaded
// run is actually SLOWER because postMessage latency dominates. Then we
// introduce the CommandBuffer path (iota's default) and watch both
// columns drop dramatically.
//
// Because iota's builder API is synchronous and lazy, "using batching"
// just means "call evaluate() on your built expression". There is no
// non-batched iota API.

import { Client, Context } from "./iota.js";

const log = (msg) => {
  const out = document.getElementById("output");
  out.textContent += msg + "\n";
};

const logError = (msg) => {
  document.getElementById("output").innerHTML += `\n<span class="error">${msg}</span>`;
};

// ---------- Correctness: arithmetic self-test at k=4 ----------

async function demoArithSelfTest(ctx, bits) {
  log(`--- Arithmetic self-test (${bits}-bit uints) ---`);
  await ctx.declareUint("a", bits);
  await ctx.declareUint("b", bits);

  const mask = (1 << bits) - 1;
  // Build one big expression that says:
  //   for every (a, b) pair and for each of {+, *}: the constraint
  //   "a = av AND b = bv IMPLIES (op(a,b) = expected)" is valid.
  // We evaluate all the "sumProp" and "mulProp" expressions in a single
  // batch and then check each is ⊤.
  const sumBits = ctx.add("a", "b");
  const mulBits = ctx.mul("a", "b");

  const propExprs = [];
  const kinds = [];
  for (let av = 0; av < (1 << bits); av++) {
    for (let bv = 0; bv < (1 << bits); bv++) {
      const aLit = ctx.uintLit(av, bits);
      const bLit = ctx.uintLit(bv, bits);
      const constraint = ctx.and(ctx.eqBits(ctx.bits("a"), aLit), ctx.eqBits(ctx.bits("b"), bLit));
      const expectedSum = (av + bv) & mask;
      const expectedMul = (av * bv) & mask;
      propExprs.push(ctx.imp(constraint, ctx.eqBits(sumBits, ctx.uintLit(expectedSum, bits))));
      kinds.push(`sum(${av},${bv})`);
      propExprs.push(ctx.imp(constraint, ctx.eqBits(mulBits, ctx.uintLit(expectedMul, bits))));
      kinds.push(`mul(${av},${bv})`);
    }
  }

  const t0 = performance.now();
  const bdds = await ctx.evaluate(propExprs);
  const submitMs = performance.now() - t0;
  const t1 = performance.now();
  const validities = await Promise.all(bdds.map((b) => b.valid()));
  const validateMs = performance.now() - t1;

  const fails = [];
  for (let i = 0; i < validities.length; i++) {
    if (!validities[i]) fails.push(kinds[i]);
  }
  log(`  ${bdds.length} assertions evaluated in one batch: submit ${submitMs.toFixed(1)}ms, validity ${validateMs.toFixed(1)}ms`);
  if (fails.length === 0) log("  PASS"); else log(`  FAIL: ${fails.slice(0, 5).join(", ")}${fails.length > 5 ? ", ..." : ""}`);
}

// ---------- Reachability: x' = x + 1 (mod 2^bits) ----------
//
// The fixpoint loop stays in JS, but each iteration's transition step is
// computed in the Rust image() op, which is one RPC per iteration.
// (If we wanted, we could push the whole fixpoint loop into Rust as a
// single RPC too, but keeping it in JS leaves it visible/interruptible.)

async function demoReachOnContext(ctx, bits) {
  log(`\n--- Reachability: x' = x + 1 (mod 2^${bits}) starting from x = 0 ---`);

  await ctx.declareUint("x", bits);
  await ctx.declarePrimed(["x"]);

  // Build init and transition relation in one batch.
  const initExpr = ctx.eqBits(ctx.bits("x"), ctx.uintLit(0, bits));
  const xPlus1 = ctx.addBits(ctx.bits("x"), ctx.uintLit(1, bits));
  const transExpr = ctx.eqBits(ctx.bits("x'"), xPlus1);
  const qXExpr = ctx.qcube(["x"]);

  const [init, trans, qX] = await ctx.evaluate([initExpr, transExpr, qXExpr]);
  log(`  init/trans/qcube built in one batch`);
  log(`  init node count: ${await init.nodeCount()}, trans node count: ${await trans.nodeCount()}`);

  const subst = await ctx.primedToUnprimed(["x"]);

  // Fixpoint: classic frontier-based reachability. Each iteration builds a
  // small IR expression that fuses and+exists+substitute (the "image" step),
  // then uses one more batch for the frontier-delta and union. Total: 2
  // RPCs per iteration.
  let reached = init;
  let frontier = init;
  const t0 = performance.now();
  let iter = 0;
  while (true) {
    iter++;
    // image(frontier) = subst( exists(frontier ∧ trans, qX), {x' ↦ x} )
    const imageExpr = ctx.subst(
      ctx.exists(ctx.and(ctx.bind(frontier), ctx.bind(trans)), ctx.bind(qX)),
      subst,
    );
    // new = image ∧ ¬reached   ;   nextReached = reached ∨ image
    const reachedBind = ctx.bind(reached);
    const newExpr = ctx.and(imageExpr, ctx.not(reachedBind));
    const nextReachedExpr = ctx.or(reachedBind, imageExpr);
    const [newBdd, nextReached] = await ctx.evaluate([newExpr, nextReachedExpr]);
    const anyNew = await newBdd.satisfiable();
    if (!anyNew) break;
    reached = nextReached;
    frontier = newBdd;
    if (iter > (1 << bits) + 2) { log("  bailing (no fixpoint?)"); break; }
  }
  const elapsed = performance.now() - t0;

  const total = 1 << bits;
  // `reached` lives in a manager with 2*bits variables (x, x'), but it
  // should only depend on the unprimed x bits. Ask for a sat count
  // restricted to `bits` care variables out of the `totalVars` declared.
  const totalVars = await ctx.numVars();
  const count = await ctx._c.call("bddCountWithNvars", { a: reached._h, nCare: bits, total: totalVars });
  log(`  fixpoint reached in ${iter} iterations, ${elapsed.toFixed(1)}ms`);
  log(`  reached |states| = ${count}  (expected ${total})  ${count === total ? "PASS" : "FAIL"}`);

  const pick = await reached.pickCube();
  if (pick.length > 0) {
    log(`  sample reached state: ${JSON.stringify(ctx.decodeCube(pick, ["x"]))}`);
  }
}

// ---------- Scaling: x*y=z at several widths ----------

async function runMultRelation(client, bits, threads, splitDepth = null) {
  // Size the manager to the workload. Bitblasting the multiplication
  // relation produces far more intermediate nodes than end up in the
  // final BDD, so we need to budget for peak, not final. Rough empirical
  // scaling: peak ~10-20× the final node count for k up to 10.
  //
  // We're constrained by WASM's 1 GiB linear-memory cap and the fact
  // that it never shrinks: each Context.close() reclaims logical slots
  // but not physical pages. Keeping budgets tight lets us finish the
  // whole sweep in one process.
  const nodeBudget = bits <= 7 ? (1 << 16) : bits <= 9 ? (1 << 19) : (1 << 21);
  const cacheBudget = nodeBudget >>> 2;
  const ctx = await Context.fromClient(client, {
    innerCap: nodeBudget, cacheCap: cacheBudget, threads,
  });
  if (splitDepth !== null) await ctx.setSplitDepth(splitDepth);
  await ctx.declareUint("x", bits);
  await ctx.declareUint("y", bits);
  await ctx.declareUint("z", bits);

  const t0 = performance.now();
  const rel = ctx.eq(ctx.mul("x", "y"), "z");
  const buildIrMs = performance.now() - t0;

  const t1 = performance.now();
  const [relBdd] = await ctx.evaluate([rel]);
  const submitMs = performance.now() - t1;

  const t2 = performance.now();
  const total = await ctx.numVars();
  const count = await relBdd.satCount(total);
  const countMs = performance.now() - t2;

  const nodes = await relBdd.nodeCount();
  const expected = Math.pow(2, 2 * bits);
  const result = {
    buildIrMs, submitMs, countMs,
    totalMs: buildIrMs + submitMs + countMs,
    nodes, ok: count === expected, count, expected,
  };
  // Release the manager. Without this, repeated runs accumulate many
  // fixed-size node tables and exhaust the worker's WASM memory budget.
  await ctx.close();
  return result;
}

async function main() {
  const hw = navigator.hardwareConcurrency || 1;
  log(`iota demo — batched command buffers`);
  log(`  hardware threads:  ${hw}`);
  log(`  SharedArrayBuffer: ${typeof SharedArrayBuffer !== "undefined"}`);

  log("\nSpinning up single-threaded client...");
  const stClient = new Client();
  await stClient.loaded;
  await stClient.init(1);

  // Correctness.
  const selfTestCtx = await Context.fromClient(stClient, { innerCap: 1 << 18, cacheCap: 1 << 16, threads: 1 });
  log("");
  await demoArithSelfTest(selfTestCtx, 4);

  // Illustrative transition-system demo.
  const reachCtx = await Context.fromClient(stClient, { innerCap: 1 << 20, cacheCap: 1 << 18, threads: 1 });
  await demoReachOnContext(reachCtx, 5);

  // Multi-thread client for the scaling demo.
  let mtClient = null;
  if (hw > 1) {
    log(`\nSpinning up ${hw}-thread client...`);
    const t0 = performance.now();
    mtClient = new Client();
    await mtClient.loaded;
    await mtClient.init(hw);
    log(`  pool ready in ${(performance.now() - t0).toFixed(0)}ms`);
  }

  // Scaling demo with split-depth tuning. oxidd's default split_depth on
  // a 16-thread pool is log2(4096*16) = 16, meaning apply ops spawn
  // parallel tasks for the first 16 levels of recursion — far too
  // aggressive for the browser's task-overhead profile. We sweep several
  // depths to find a better sweet spot.
  log("\n=== Scaling demo: x * y = z ===");
  log("  st = single-threaded; mt(d) = 16 threads with split_depth=d");
  log(`  (oxidd's default split_depth for 16 threads is log2(4096*16) = 16)`);

  const depths = mtClient ? [0, 4] : [];
  const header = [
    "k".padStart(2),
    "nodes".padStart(8),
    "st(ms)".padStart(8),
    ...depths.map((d) => `mt(${d})ms`.padStart(10)),
    "best-mt".padStart(8),
    "speedup".padStart(7),
    "result",
  ].join("  ");
  log(header);

  // Run each configuration with a try/catch so one blowup (OOM, stack
  // overflow on pathological split-depth combos, etc.) doesn't abort
  // the whole sweep. Failures are rendered as "ERR".
  const runSafe = async (label, fn) => {
    try {
      return { kind: "ok", value: await fn() };
    } catch (e) {
      log(`  ${label} failed: ${e.message || e}`);
      return { kind: "err", error: e };
    }
  };

  for (const k of [5, 7, 9, 10]) {
    const stR = await runSafe(`st k=${k}`, () => runMultRelation(stClient, k, 1));
    const mtRs = [];
    for (const d of depths) {
      mtRs.push({
        d,
        r: await runSafe(`mt(${d}) k=${k}`, () => runMultRelation(mtClient, k, hw, d)),
      });
    }

    const stCell = stR.kind === "ok" ? stR.value.totalMs.toFixed(1) : "ERR";
    const stNodes = stR.kind === "ok" ? String(stR.value.nodes) : "-";
    const stOk = stR.kind === "ok" && stR.value.ok;

    const mtCells = mtRs.map(({ r }) => r.kind === "ok" ? r.value.totalMs.toFixed(1) : "ERR");
    const mtOkTimes = mtRs.filter(({ r }) => r.kind === "ok" && r.value.ok).map(({ r }) => r.value.totalMs);
    const bestMt = mtOkTimes.length ? Math.min(...mtOkTimes) : null;

    const allOk = stOk && mtRs.every(({ r }) => r.kind === "ok" && r.value.ok);
    const row = [
      String(k).padStart(2),
      stNodes.padStart(8),
      stCell.padStart(8),
      ...mtCells.map((c) => c.padStart(10)),
      bestMt !== null ? bestMt.toFixed(1).padStart(8) : "-".padStart(8),
      (bestMt !== null && stR.kind === "ok") ? (stR.value.totalMs / bestMt).toFixed(2).padStart(7) : "-".padStart(7),
      allOk ? "PASS" : (stOk || mtOkTimes.length > 0) ? "partial" : "FAIL",
    ];
    log(row.join("  "));
  }

  log("\nDone.");
}

main().catch((e) => {
  logError(`Error: ${e.message || e}\n${e.stack || ""}`);
  console.error(e);
});
