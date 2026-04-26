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
  // Size the manager to the workload. The multiplication relation's
  // final BDD grows ~2.7× per bit (canonical Bryant exponential blowup).
  // Peak node count during bitblasting is higher than final; for a
  // parallel manager the peak is higher still because multiple rayon
  // tasks each hold intermediate BDDs alive concurrently.
  //
  // Native measurements of the FINAL relation size:
  //   k=10: 194k nodes     k=12: 1.4M     k=13: 3.9M     k=14: ~10M
  //
  // Rough peak multipliers I've observed: ~5× final for single-thread,
  // ~8-12× for 16-thread with non-zero split_depth. Empirical table
  // below targets "peak that avoids 'AND: oom' errors".
  const peakEstimate = (() => {
    // Bryant exponent table (final-size only), bits -> nodes,
    // measured on our native Rust test suite:
    const finalTable = {
      5: 1.3e3, 6: 3.5e3, 7: 1.0e4, 8: 2.7e4, 9: 7.1e4,
      10: 2.0e5, 11: 5.2e5, 12: 1.4e6, 13: 3.9e6, 14: 1.1e7,
    };
    const finalNodes = finalTable[bits] ?? Math.pow(2.72, bits);
    // Bigger multiplier for multi-threaded runs: parallel apply keeps
    // more intermediates alive at once.
    const peakMultiplier = threads > 1 ? 8 : 5;
    return Math.ceil(finalNodes * peakMultiplier);
  })();
  // Cap at 1<<26 (~67M nodes, ~1 GiB of slots) within the 4 GiB wasm32
  // linear-memory ceiling. Beyond that the Edge type (32-bit index)
  // starts approaching its own limit anyway.
  const nodeBudget = Math.max(1 << 14, Math.min(1 << 26, peakEstimate));
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
  // Cap the mt pool at 4 threads. More workers = more per-thread stack
  // reserved in the shared 1 GiB of Wasm linear memory (each one is
  // 8 MiB), which is space that can't hold BDD nodes. At 16 threads we
  // lose 128 MiB to stacks alone, and apply-scaling gains are modest
  // in the browser anyway due to Web Worker scheduling overhead.
  const hw = Math.min(navigator.hardwareConcurrency || 1, 4);
  log(`iota demo — batched command buffers`);
  log(`  hardware threads:  ${navigator.hardwareConcurrency || 1} (using ${hw})`);
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

  // Correctness demos done. Release the worker so the scaling sweep
  // starts from clean Wasm memory.
  stClient.terminate();

  // For the scaling sweep we spawn a fresh Client per (threads, k)
  // configuration. Wasm linear memory only ever grows: a Context.close()
  // frees the node table's slots but not the Wasm pages backing it, so
  // a sequential sweep accumulates peak-sized allocations across
  // iterations and eventually OOMs. Spinning up a fresh worker gives
  // each k a clean slate.
  const makeClient = async (numThreads) => {
    const c = new Client();
    await c.loaded;
    await c.init(numThreads);
    return c;
  };

  // Scaling demo with split-depth tuning. oxidd's default split_depth
  // is log2(4096 * num_threads): at 4 threads, = 14. apply ops spawn
  // parallel tasks for the first 14 levels of recursion, which is too
  // aggressive for the browser's task-overhead profile. We sweep
  // smaller depths to find a better sweet spot.
  log("\n=== Scaling demo: x * y = z ===");
  log(`  st = single-threaded; mt(d) = ${hw} threads with split_depth=d`);
  log(`  (oxidd's default split_depth for ${hw} threads is log2(4096*${hw}) = ${Math.log2(4096 * hw).toFixed(0)})`);

  const depths = hw > 1 ? [0, 4] : [];
  const header = [
    "k".padStart(2),
    "nodes".padStart(10),
    "MiB".padStart(6),
    "st(ms)".padStart(9),
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

  for (const k of [7, 10, 12, 13, 14]) {
    // Fresh st client per k so Wasm memory from prior (large) iterations
    // doesn't starve this one.
    const stClientK = await makeClient(1);
    const stR = await runSafe(`st k=${k}`, () => runMultRelation(stClientK, k, 1));
    stClientK.terminate();

    const mtRs = [];
    if (hw > 1) {
      for (const d of depths) {
        const mtClientK = await makeClient(hw);
        mtRs.push({
          d,
          r: await runSafe(`mt(${d}) k=${k}`, () => runMultRelation(mtClientK, k, hw, d)),
        });
        mtClientK.terminate();
      }
    }

    const stCell = stR.kind === "ok" ? stR.value.totalMs.toFixed(1) : "ERR";
    const stNodes = stR.kind === "ok" ? String(stR.value.nodes) : "-";
    const stMiB = stR.kind === "ok" ? (stR.value.nodes * 16 / (1024 * 1024)).toFixed(1) : "-";
    const stOk = stR.kind === "ok" && stR.value.ok;

    const mtCells = mtRs.map(({ r }) => r.kind === "ok" ? r.value.totalMs.toFixed(1) : "ERR");
    const mtOkTimes = mtRs.filter(({ r }) => r.kind === "ok" && r.value.ok).map(({ r }) => r.value.totalMs);
    const bestMt = mtOkTimes.length ? Math.min(...mtOkTimes) : null;

    const allOk = stOk && mtRs.every(({ r }) => r.kind === "ok" && r.value.ok);
    const row = [
      String(k).padStart(2),
      stNodes.padStart(10),
      stMiB.padStart(6),
      stCell.padStart(9),
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
