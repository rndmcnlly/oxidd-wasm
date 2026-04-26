# oxidd-wasm

WebAssembly bindings for [OxiDD](https://github.com/oxidd/oxidd), exposing Binary Decision Diagrams to JavaScript. Single-threaded wasm32, no `SharedArrayBuffer` required.

**Live demos:**

- **[oxidd-wasm](https://rndmcnlly.github.io/oxidd-wasm/)**: raw BDD primitives, 8-queens example.
- **[iota](https://rndmcnlly.github.io/oxidd-wasm/iota.html)**: typed symbolic programming built on top (uints, bools, primed variables, reachability, mult-relation scaling up to k=16 with a clean OOM boundary at k=17).

## What this is

A proof-of-concept port of OxiDD (a parallel BDD library written in Rust) to the browser. The demo builds multi-million-node BDDs, including the Bryant-worst-case multiplication relation at 14-bit width, inside a single Web Worker in about 1.5 seconds.

## Status

Proof of concept, not a production library. Specifically:

- **Stable Rust.** Builds on `stable` with the `wasm32-unknown-unknown` target.
- **Patched OxiDD.** We maintain [a fork](https://github.com/rndmcnlly/oxidd/tree/wasm32-support) that makes `oxidd-manager-index` strictly single-threaded on wasm32 (no rayon pool, all `WorkerPool` methods execute inline). See "Parallelism postmortem" below for why.
- **Garbage collection is manual on wasm32.** OxiDD's background GC thread is stubbed out. Explicit `manager.gc()` calls still work.
- **API coverage is partial.** BDDs only (not BCDD or ZBDD from the JS side), with boolean ops, quantifiers, substitution, image/preimage, and the batched `CommandBuffer` path that iota builds on.

## Architecture

```
┌─────────────┐  postMessage   ┌─────────────────┐
│ main thread │ ─────────────▶ │ manager worker  │
│  (UI, RPC)  │ ◀───────────── │ (hosts OxiDD +  │
└─────────────┘                │  wasm memory)   │
                               └─────────────────┘
```

One Web Worker owns one Wasm module instance. The main thread speaks Promise-wrapped RPC to it using integer handles for Rust-side objects. BDD handles are auto-freed via `FinalizationRegistry` batching.

## Building

```bash
git clone --recurse-submodules https://github.com/rndmcnlly/oxidd-wasm.git
cd oxidd-wasm

rustup target add wasm32-unknown-unknown
cargo install wasm-pack

just serve
# → http://localhost:8080
```

Any static file server works for deployment; no special headers required.

## Using the API

Declare variables, build a formula with AND/OR/NOT, and count its satisfying assignments. All calls are async because they cross the worker boundary:

```js
import { OxiddClient } from "./index.js";

const client = new OxiddClient();
await client.init();

// newManager(inner_node_capacity, apply_cache_capacity)
const mgr = await client.newManager(65536, 65536);

// Declare two boolean variables; addVars returns their integer ids.
const [a, b] = await mgr.addVars(2);
const va = await mgr.var_(a);
const vb = await mgr.var_(b);

// f = (a AND b) OR (NOT a)
const ab   = await va.and(vb);
const nota = await va.not();
const f    = await ab.or(nota);

console.log(await f.satCount(2));  // 3 out of 4 assignments
console.log(await f.nodeCount());  // DAG size
```

### Every op is a round-trip

Each `.and`, `.or`, `.not`, etc. is one `postMessage` to the worker, one synchronous Rust call, and one `postMessage` back. That's fine for a few dozen ops. It is a disaster for building multi-million-node BDDs from JS one apply at a time: on a realistic workload the postMessage latency dominates the actual BDD work by ~10x.

### Batched command buffers

The fix is a graphics-API analogy. Instead of issuing one draw call per primitive, you fill a command buffer with an entire scene's worth of work and submit it once. Here the "scene" is a program of BDD ops (`ops`, `a`, `b`, `c`, `outputs` arrays, one row per op) referring to previously-bound BDD handles and to each other by index. `CommandBuffer::submit` runs the whole program inside a single Rust entry and returns all requested result handles in one reply.

The command-buffer primitive is exposed directly in `www/manager-worker.js` (`cbNew`, `cbBind`, `cbSetProgram`, `cbSubmit`), but you don't usually touch it by hand. The iota layer below is designed around it.

## iota: typed symbolic programming

`www/iota.js` is a higher-level layer inspired by [`omega.symbolic.fol`](https://github.com/tulip-control/omega): typed unsigned integers, booleans, primed counterparts for transition systems, a bitblaster that compiles expressions like `x * y = z` into BDD operations, and fused operations like `image` and `preimage` that live Rust-side.

iota's builder API is synchronous and returns lazy IR nodes; calling `ctx.evaluate([exprs])` is what actually emits a command buffer and submits it in one postMessage. Shared subexpressions are CSE'd by object identity before emission.

```js
import { Context } from "./iota.js";

const ctx = await Context.create();

await ctx.declareUint("x", 8);
await ctx.declareUint("y", 8);
await ctx.declareUint("z", 8);

// Build the IR (synchronous, no worker traffic):
const rel = ctx.eq(ctx.mul("x", "y"), "z");

// One round-trip for the entire bitblast:
const [bdd] = await ctx.evaluate([rel]);
console.log(await bdd.satCount(await ctx.numVars()));  // 65536
```

Heavyweight traversals (`support`, `pick_cube`, `cube`, `image`, `preimage`, `substitute`) live in Rust as single FFI hops; the bitblaster and fixpoint loops stay in JS where they're readable and interruptible.

## Parallelism postmortem

Earlier versions of this repo used `wasm-bindgen-rayon` to run OxiDD's parallel BDD apply across a Web-Worker-based rayon pool (16 workers on a 16-core machine). We measured speedup in Chrome at various workload sizes and found essentially **no parallel speedup** for our BDD workloads: `mt(0)` through `mt(16)` all landed within 10% of single-threaded `st` on mult-relation at k=7..14.

Chrome DevTools CPU profiling gave a clean diagnosis:

- **67% of all sampled CPU time** (81.9 s of 121 s) was rayon workers parked in `WorkerThread::wait_until_cold`, waiting for work that never came with enough granularity to be worth dispatching.
- When workers did wake up, **5–12% of their active time** was spent in `parking_lot::RawMutex::lock_slow` contending on the per-level unique-table mutexes.
- Only **~2.4% of CPU time** was actually in `apply_bin` (BDD apply recursion).
- The rayon coordination machinery (`StackJob`, `join_context`, `LockLatch::wait_and_reset`) collectively ran nearly as long as the useful work.

Two causes: (1) Web Worker scheduling and `SharedArrayBuffer` atomics add per-task coordination cost higher than native rayon assumes, and (2) BDD apply is highly imbalanced — one branch often holds 99% of the subtree, so most rayon "splits" hand one worker everything and leave the others idle.

Rather than keep a feature that costs complexity without producing speedup, we ripped it out entirely:

- dropped `wasm-bindgen-rayon` as a dependency
- disabled the `multi-threading` feature on `oxidd`
- extended our OxiDD fork to make `Workers` strictly serial on wasm32 (all `join`/`broadcast`/`install` execute inline; no rayon pool is constructed)
- moved from nightly to stable Rust, dropped `-Z build-std`
- removed `SharedArrayBuffer` / `crossOriginIsolated` / COOP+COEP requirements

The resulting Wasm module is about 45% smaller (162 KB vs 294 KB), deploys to any static host, and performs indistinguishably from the 16-thread version.

## Notable build flags

```
-C link-arg=--import-memory
-C link-arg=--max-memory=4294967296
-C link-arg=-zstack-size=8388608
```

- `--max-memory=4294967296` is the wasm32 ceiling (4 GiB). The multiplication relation at k=15 produces ~10M final nodes × 16 B = 157 MiB, but peak during bitblasting plus accumulated slot-table growth pushes a sequential k=7..15 sweep well past 1 GiB.
- `-zstack-size=8388608` (8 MiB) bumps the Wasm stack from the linker default of 1 MiB. Rust targeting wasm32 uses several times more stack per frame than native x86_64 due to the linear-memory calling convention; deep BDD apply recursion during bitblasting can reach several dozen frames, each with intermediate-BDD bookkeeping.

### Pre-sized sat_count cache

At k=16 the multiplication-relation apply completes fine, but validation (`sat_count`) used to OOM. The cause: oxidd's `SatCountCache` is a `HashMap<NodeID, f64>` that grows by doubling. The final rehash before reaching ~30M entries briefly holds both the old (32M-bucket) and new (64M-bucket) tables simultaneously, which adds ~1-2 GiB of hash-table overhead on top of the ~1 GiB BDD arena, exceeding the 4 GiB wasm32 heap. Because `HashMap::insert` uses infallible allocation, this surfaces as a Rust panic rather than a clean `Err` return, trapping the wasm.

Fix: we call `node_count()` first to get the exact DAG size, then `HashMap::reserve(n)` on the cache's map before calling `sat_count`. This costs one extra O(N) traversal but eliminates the rehash spike, trading ~15% extra time for about one more doubling (k) of scaling headroom. See `BDD::sat_count` in `crates/oxidd-wasm/src/lib.rs`.

### Measured scaling (browser, k = bits of x * y = z)

| k  | final nodes | slot MiB | total (s) | status            |
|----|-------------|---------:|----------:|-------------------|
| 7  |       2,634 |     0.04 |    0.002  | PASS              |
| 10 |      58,533 |     0.9  |    0.015  | PASS              |
| 12 |     464,183 |     7.1  |    0.14   | PASS              |
| 13 |   1,292,160 |    19.7  |    0.45   | PASS              |
| 14 |   3,697,097 |    56.4  |    1.49   | PASS              |
| 15 |  10,304,530 |   157.2  |    6.71   | PASS              |
| 16 |  29,511,259 |   450.3  |   22.99   | PASS              |
| 17 |          — |       — |        — | OOM inside apply  |

k=17 fails inside an apply step (e.g. `OR: oom`) through oxidd's fallible `AllocResult` path: a rejected promise, not a panic. That's the 4 GiB wasm32 ceiling itself, not a fixable allocation spike — peak memory during apply is roughly 3-5× final-node size, and k=17's ~84M final nodes × ~33 B amortized (slot + unique table + apply cache) ≈ 2.7 GiB resident before peak.

## License

Dual-licensed under MIT OR Apache-2.0, matching OxiDD. See `LICENSE-MIT` and `LICENSE-APACHE`.

## Acknowledgements

- [OxiDD](https://github.com/oxidd/oxidd) by Nils Husung et al. (TU Dresden), which does the real work.
