# oxidd-wasm

WebAssembly bindings for [OxiDD](https://github.com/oxidd/oxidd), exposing Binary Decision Diagrams to JavaScript with multi-threaded rayon execution via shared memory.

**Live demos** (require a browser with `SharedArrayBuffer` support: Chrome, Firefox, Safari 16.4+):

- **[oxidd-wasm](https://rndmcnlly.github.io/oxidd-wasm/)**: raw BDD primitives, 8-queens example.
- **[iota](https://rndmcnlly.github.io/oxidd-wasm/iota.html)**: typed symbolic programming built on top (uints, bools, primed variables, reachability).

## What this is

A proof-of-concept port of OxiDD (a modern, parallel BDD library written in Rust) to the browser. The goal is exploratory: bringing a real, fast BDD engine to JavaScript without dropping the thread-level parallelism that makes OxiDD interesting in the first place.

The demo solves 8-queens as a BDD on 64 variables (~83k internal nodes, 92 solutions) in roughly 200 ms on a recent MacBook using 16 threads.

## Status

This is a proof of concept, not a production library. Specifically:

- **Nightly Rust required.** We need `-Z build-std=panic_abort,std` to compile the standard library with atomics enabled, and unstable linker flags for shared memory.
- **Patched OxiDD.** We maintain [a fork](https://github.com/rndmcnlly/oxidd/tree/wasm32-support) with a two-file patch that makes `oxidd-manager-index` use rayon's global pool on wasm32 instead of building a private one (the latter tries to `std::thread::spawn`, which is unsupported on WASM). The patch is minimal and target-gated; we intend to upstream it.
- **Garbage collection is disabled on wasm32.** OxiDD's background GC thread is stubbed out. Manual `manager.gc()` calls still work synchronously.
- **API coverage is partial.** Only BDDs (not BCDD or ZBDD) are exposed, and only the core boolean operations plus a few queries.
- **Single-thread-only fallback not yet implemented.** If the browser refuses `SharedArrayBuffer`, the demo fails rather than degrading.

## Architecture

The WASM module cannot run on the main browser thread: `parking_lot`'s mutexes use `Atomics.wait` under contention, which throws a `TypeError` on the main thread by spec. So:

```
┌─────────────┐  postMessage   ┌─────────────────┐
│ main thread │ ─────────────▶ │ manager worker  │
│  (UI, RPC)  │ ◀───────────── │ (hosts OxiDD)   │
└─────────────┘                └────────┬────────┘
                                        │
                                        │ wasm-bindgen-rayon
                                        ▼
                             ┌─────────────────────┐
                             │ N rayon workers     │
                             │ (shared WASM memory)│
                             └─────────────────────┘
```

- The manager worker is a real thread (not the main thread), so it can block on condvars legally.
- Rayon workers are spawned as nested workers from the manager worker, all sharing one `WebAssembly.Memory` instance.
- Main thread communicates with the manager worker via Promise-wrapped RPC using integer handles for Rust-side objects.

## Building

You need:

- Rust nightly with `rust-src` and the `wasm32-unknown-unknown` target
- [`wasm-pack`](https://rustwasm.github.io/wasm-pack/)
- [`just`](https://github.com/casey/just) (optional; it's just a Makefile)
- Python 3 (for the dev server)

```bash
# Get everything, including the patched oxidd submodule
git clone --recurse-submodules https://github.com/rndmcnlly/oxidd-wasm.git
cd oxidd-wasm

# Install Rust prerequisites
rustup toolchain install nightly
rustup component add rust-src --toolchain nightly
rustup target add wasm32-unknown-unknown --toolchain nightly
cargo install wasm-pack

# Build and serve
just serve
# → http://localhost:8080
```

The dev server (`www/serve.py`) adds the `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers needed for `SharedArrayBuffer`. For deployment to static hosts that can't set headers (GitHub Pages, etc.), we include [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) which patches them in client-side.

## Using the API

The JS API is async (all calls cross a worker boundary):

```js
import { OxiddClient } from "./index.js";

const client = new OxiddClient();
await client.init(navigator.hardwareConcurrency);

const mgr = await client.newManager(65536, 65536, navigator.hardwareConcurrency);
const [a, b] = await mgr.addVars(2);

const va = await mgr.var_(a);
const vb = await mgr.var_(b);
const expr = await (await va.and(vb)).or(await va.not());

console.log(await expr.satCount(2));  // 3
```

Every BDD operation is one postMessage round-trip, so latency-bound workloads will benefit from batching. This is left as a future optimization.

## iota: typed symbolic programming

`www/iota.js` is a higher-level layer inspired by [`omega.symbolic.fol`](https://github.com/tulip-control/omega): typed unsigned integers, booleans, primed counterparts for transition systems, a bitblaster that compiles expressions like `x * y = z` into BDD operations, and fused operations like `image` and `preimage` that live Rust-side to avoid postMessage storms.

```js
import { Context } from "./iota.js";

const ctx = await Context.create({ threads: navigator.hardwareConcurrency });

await ctx.declareUint("x", 8);
await ctx.declareUint("y", 8);
await ctx.declareUint("z", 8);

const u = await ctx.eq(await ctx.mul("x", "y"), "z");
console.log(await u.satCount(await ctx.numVars()));    // 65536

// Transition systems
await ctx.declarePrimed(["x"]);
const xBits     = await ctx.bits("x");
const xPrime    = await ctx.bits("x'");
const xPlus1    = await ctx.addBits(xBits, await ctx.uintLit(1, 8));
const trans     = await ctx.eqBits(xPrime, xPlus1);

// Fixpoint stays in JS (visible, interruptible); image is one FFI call.
const qX        = await ctx.qcube(["x"]);
const subst     = await ctx.primedToUnprimed(["x"]);
let reached     = await ctx.eqBits(xBits, await ctx.uintLit(0, 8));
let frontier    = reached;
while (true) {
  const next      = await frontier.image(trans, qX, subst);
  const newStates = await next.and(await reached.not());
  if (!await newStates.satisfiable()) break;
  reached  = await reached.or(next);
  frontier = newStates;
}
console.log(await reached.satCount(8));                // 256
```

Design split: heavyweight traversals (`support`, `pick_cube`, `cube`, `image`, `preimage`, `substitute`) live in Rust as single FFI hops; the bitblaster and the fixpoint loop stay in JS where they're readable and interruptible. BDD handles are auto-freed via a `FinalizationRegistry` that batches drops across microtasks.

## Notable build flags

For reference (and for anyone trying to replicate this), the working set of `RUSTFLAGS` is:

```
-C target-feature=+atomics,+bulk-memory,+mutable-globals
-C link-arg=--import-memory
-C link-arg=--shared-memory
-C link-arg=--max-memory=4294967296
-C link-arg=--export=__wasm_init_tls
-C link-arg=--export=__tls_size
-C link-arg=--export=__tls_align
-C link-arg=--export=__tls_base
-C link-arg=-zstack-size=8388608
```

The `--export=__wasm_init_tls` et al are required after [rust-lang/rust#147225](https://github.com/rust-lang/rust/pull/147225) (landed late 2025), which stopped rustc from auto-exporting these for shared-memory WASM. Without them, `wasm-bindgen`'s threading transform panics with `failed to find __wasm_init_tls`.

The `-zstack-size=8388608` (8 MiB) bumps the per-worker stack from its 1 MiB default. Rust targeting WASM uses noticeably more stack per frame than native x86_64 due to the linear-memory calling convention, and BDD apply/cofactor walks recurse deeply on the order of the number of variables in the function. 8 MiB is enough to comfortably handle ten-bit multiplication relations (~30 levels) with room to spare.

## License

Dual-licensed under MIT OR Apache-2.0, matching OxiDD. See `LICENSE-MIT` and `LICENSE-APACHE`.

## Acknowledgements

- [OxiDD](https://github.com/oxidd/oxidd) by Nils Husung et al. (TU Dresden), which does all the real work.
- [`wasm-bindgen-rayon`](https://github.com/GoogleChromeLabs/wasm-bindgen-rayon) by Ingvar Stepanyan et al. (Google), which solves the non-trivial problem of rayon-in-the-browser.
- [`coi-serviceworker`](https://github.com/gzuidhof/coi-serviceworker) by Guido Zuidhof, which papers over the COOP/COEP deployment issue.
