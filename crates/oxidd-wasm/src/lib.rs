#![allow(clippy::must_use_candidate)]

use oxidd::bdd::{BDDFunction, BDDManagerRef};
use oxidd::{
    BooleanFunction, BooleanFunctionQuant, Function, HasLevel, HasWorkers, InnerNode, LevelNo,
    Manager, ManagerRef, Node, VarNo,
};
use oxidd_core::WorkerPool;
use oxidd::util::num::F64;
use oxidd::Subst;
use oxidd_core::function::FunctionSubst;
use oxidd_core::util::SatCountCache;
use std::collections::HashSet;
use std::hash::BuildHasherDefault;
use rustc_hash::FxHasher;
use wasm_bindgen::prelude::*;

pub use wasm_bindgen_rayon::init_thread_pool;

#[wasm_bindgen(js_name = "setPanicHook")]
pub fn set_panic_hook() {
    console_error_panic_hook::set_once();
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct BDDManager {
    inner: BDDManagerRef,
}

#[wasm_bindgen]
impl BDDManager {
    #[wasm_bindgen(constructor)]
    pub fn new(inner_node_capacity: usize, apply_cache_capacity: usize, threads: u32) -> Self {
        Self {
            inner: oxidd::bdd::new_manager(inner_node_capacity, apply_cache_capacity, threads),
        }
    }

    pub fn add_vars(&self, count: u32) -> Vec<u32> {
        self.inner.with_manager_exclusive(|m| {
            let start = m.num_vars();
            m.add_vars(count);
            (start..start + count).collect()
        })
    }

    pub fn num_vars(&self) -> u32 {
        self.inner.with_manager_shared(|m| m.num_vars())
    }

    pub fn num_inner_nodes(&self) -> usize {
        self.inner.with_manager_shared(|m| m.num_inner_nodes())
    }

    pub fn gc(&self) -> usize {
        self.inner.with_manager_shared(|m| m.gc())
    }

    /// Current recursion split depth. See `set_split_depth`.
    pub fn split_depth(&self) -> u32 {
        self.inner.with_manager_shared(|m| m.workers().split_depth())
    }

    /// Set the recursion depth up to which BDD apply operations split into
    /// parallel tasks (via `rayon::join`). Pass `None` to restore oxidd's
    /// default of `log2(4096 * num_threads)`, which is aggressive and often
    /// pessimal in the browser where task overhead is higher than on native.
    /// Pass `Some(0)` to disable parallelism entirely (fully serial apply).
    /// Tune smaller values (e.g., 3-6) to find the sweet spot for your
    /// workload.
    pub fn set_split_depth(&self, depth: Option<u32>) {
        self.inner.with_manager_shared(|m| m.workers().set_split_depth(depth));
    }

    pub fn var(&self, var_no: u32) -> Result<BDD, JsValue> {
        self.inner.with_manager_shared(|m| {
            BDDFunction::var(m, var_no)
                .map(|f| BDD { inner: f })
                .map_err(|_| JsValue::from_str("out of memory creating variable"))
        })
    }

    pub fn true_(&self) -> BDD {
        BDD {
            inner: self.inner.with_manager_shared(|m| BDDFunction::t(m)),
        }
    }

    pub fn false_(&self) -> BDD {
        BDD {
            inner: self.inner.with_manager_shared(|m| BDDFunction::f(m)),
        }
    }

    /// Build the conjunction of literals: for each `(var_no, polarity)`, include
    /// `v` if polarity is true, `~v` if false. Empty list returns `true`.
    ///
    /// This is a single FFI hop replacing `N-1` `and` calls from JS.
    pub fn cube(&self, var_nos: Vec<u32>, polarities: Vec<u8>) -> Result<BDD, JsValue> {
        if var_nos.len() != polarities.len() {
            return Err(JsValue::from_str("cube: var_nos and polarities length mismatch"));
        }
        self.inner.with_manager_shared(|m| {
            let mut acc = BDDFunction::t(m);
            for (&v, &p) in var_nos.iter().zip(polarities.iter()) {
                let lit = if p != 0 {
                    BDDFunction::var(m, v).map_err(|_| JsValue::from_str("cube: var oom"))?
                } else {
                    BDDFunction::not_var(m, v).map_err(|_| JsValue::from_str("cube: not_var oom"))?
                };
                acc = acc.and(&lit).map_err(|_| JsValue::from_str("cube: and oom"))?;
            }
            Ok(BDD { inner: acc })
        })
    }

    /// Build an empty substitution. Use `SubstitutionBuilder::add` to populate
    /// it, then `SubstitutionBuilder::build` to get a reusable `Substitution`.
    pub fn new_substitution_builder(&self) -> SubstitutionBuilder {
        SubstitutionBuilder {
            vars: Vec::new(),
            replacements: Vec::new(),
        }
    }

    /// Submit a command buffer and execute it. Returns one BDD per instruction
    /// index listed in `outputs`, in the same order. All intermediate BDDs
    /// created during execution (ones not in `outputs`) are dropped.
    ///
    /// This is the graphics-API-style batched submission path: caller records
    /// many BDD operations into a `CommandBuffer` on the JS side, then submits
    /// it here in one FFI hop. Amortizes postMessage latency across the whole
    /// batch and lets oxidd's internal rayon parallelism see enough work per
    /// call to actually hide coordination overhead.
    pub fn submit(&self, cb: &CommandBuffer) -> Result<Vec<BDD>, JsValue> {
        cb.execute(self)
    }
}

// ---------------------------------------------------------------------------
// BDD node wrapper
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct BDD {
    inner: BDDFunction,
}

#[wasm_bindgen]
impl BDD {
    pub fn not(&self) -> Result<BDD, JsValue> {
        self.inner
            .not()
            .map(|f| BDD { inner: f })
            .map_err(|_| JsValue::from_str("out of memory in not"))
    }

    pub fn and(&self, other: &BDD) -> Result<BDD, JsValue> {
        self.inner
            .and(&other.inner)
            .map(|f| BDD { inner: f })
            .map_err(|_| JsValue::from_str("out of memory in and"))
    }

    pub fn or(&self, other: &BDD) -> Result<BDD, JsValue> {
        self.inner
            .or(&other.inner)
            .map(|f| BDD { inner: f })
            .map_err(|_| JsValue::from_str("out of memory in or"))
    }

    pub fn xor(&self, other: &BDD) -> Result<BDD, JsValue> {
        self.inner
            .xor(&other.inner)
            .map(|f| BDD { inner: f })
            .map_err(|_| JsValue::from_str("out of memory in xor"))
    }

    pub fn nand(&self, other: &BDD) -> Result<BDD, JsValue> {
        self.inner
            .nand(&other.inner)
            .map(|f| BDD { inner: f })
            .map_err(|_| JsValue::from_str("out of memory in nand"))
    }

    pub fn nor(&self, other: &BDD) -> Result<BDD, JsValue> {
        self.inner
            .nor(&other.inner)
            .map(|f| BDD { inner: f })
            .map_err(|_| JsValue::from_str("out of memory in nor"))
    }

    pub fn imp(&self, other: &BDD) -> Result<BDD, JsValue> {
        self.inner
            .imp(&other.inner)
            .map(|f| BDD { inner: f })
            .map_err(|_| JsValue::from_str("out of memory in imp"))
    }

    pub fn equiv(&self, other: &BDD) -> Result<BDD, JsValue> {
        self.inner
            .equiv(&other.inner)
            .map(|f| BDD { inner: f })
            .map_err(|_| JsValue::from_str("out of memory in equiv"))
    }

    pub fn ite(&self, then_case: &BDD, else_case: &BDD) -> Result<BDD, JsValue> {
        self.inner
            .ite(&then_case.inner, &else_case.inner)
            .map(|f| BDD { inner: f })
            .map_err(|_| JsValue::from_str("out of memory in ite"))
    }

    pub fn satisfiable(&self) -> bool {
        self.inner.satisfiable()
    }

    pub fn valid(&self) -> bool {
        self.inner.valid()
    }

    /// Equality of canonical BDDs (same function).
    pub fn equals(&self, other: &BDD) -> bool {
        self.inner == other.inner
    }

    pub fn sat_count(&self, num_vars: u32) -> f64 {
        let mut cache = SatCountCache::<F64, BuildHasherDefault<FxHasher>>::default();
        self.inner.sat_count(num_vars as LevelNo, &mut cache).0
    }

    /// Sat count under a "care set" with `n_care` care variables out of
    /// `total` declared variables. Matches dd-style semantics: result is
    /// `sat_count_total / 2^(total - n_care)` so callers who want the count
    /// restricted to their care set get the right number.
    pub fn count_with_nvars(&self, n_care: u32, total: u32) -> Result<f64, JsValue> {
        if n_care > total {
            return Err(JsValue::from_str("count_with_nvars: n_care > total"));
        }
        let mut cache = SatCountCache::<F64, BuildHasherDefault<FxHasher>>::default();
        let full = self.inner.sat_count(total as LevelNo, &mut cache).0;
        let shift = total - n_care;
        Ok(full / (1u64 << shift) as f64)
    }

    pub fn node_count(&self) -> usize {
        self.inner.node_count()
    }

    pub fn cofactor_true(&self) -> Option<BDD> {
        self.inner.cofactor_true().map(|f| BDD { inner: f })
    }

    pub fn cofactor_false(&self) -> Option<BDD> {
        self.inner.cofactor_false().map(|f| BDD { inner: f })
    }

    pub fn exists(&self, vars: &BDD) -> Result<BDD, JsValue> {
        self.inner
            .exists(&vars.inner)
            .map(|f| BDD { inner: f })
            .map_err(|_| JsValue::from_str("out of memory in exists"))
    }

    pub fn forall(&self, vars: &BDD) -> Result<BDD, JsValue> {
        self.inner
            .forall(&vars.inner)
            .map(|f| BDD { inner: f })
            .map_err(|_| JsValue::from_str("out of memory in forall"))
    }

    /// Apply a pre-built substitution to this function.
    pub fn substitute(&self, subst: &Substitution) -> Result<BDD, JsValue> {
        self.inner
            .substitute(&subst.inner)
            .map(|f| BDD { inner: f })
            .map_err(|_| JsValue::from_str("out of memory in substitute"))
    }

    /// Support: the set of variable numbers this function depends on.
    ///
    /// Linear in DAG size via memoized post-order walk over `node_id`s,
    /// done entirely in Rust so JS sees only a single FFI hop regardless
    /// of BDD size.
    pub fn support(&self) -> Vec<u32> {
        self.inner.with_manager_shared(|manager, edge| {
            let mut visited: HashSet<usize, BuildHasherDefault<FxHasher>> = HashSet::default();
            let mut levels: HashSet<LevelNo, BuildHasherDefault<FxHasher>> = HashSet::default();

            fn walk<M: Manager>(
                manager: &M,
                edge: &M::Edge,
                visited: &mut HashSet<usize, BuildHasherDefault<FxHasher>>,
                levels: &mut HashSet<LevelNo, BuildHasherDefault<FxHasher>>,
            ) where
                M::InnerNode: HasLevel,
            {
                let id = <M::Edge as oxidd_core::Edge>::node_id(edge);
                if !visited.insert(id) {
                    return;
                }
                if let Node::Inner(node) = manager.get_node(edge) {
                    levels.insert(node.level());
                    for child in node.children() {
                        walk(manager, &*child, visited, levels);
                    }
                }
            }

            walk(manager, edge, &mut visited, &mut levels);

            let mut vars: Vec<VarNo> = levels
                .into_iter()
                .map(|lvl| manager.level_to_var(lvl))
                .collect();
            vars.sort_unstable();
            vars
        })
    }

    /// Pick one satisfying cube. Returns a flat `Int8Array`-compatible vector
    /// of length `num_vars`: `-1` = don't care, `0` = false, `1` = true.
    /// Returns empty vector (length 0) if the function is unsatisfiable.
    ///
    /// The `choice` callback from `pick_cube` is set to always return `false`
    /// when forced, matching "canonical minterm" semantics.
    pub fn pick_cube(&self) -> Vec<i8> {
        match self.inner.pick_cube(|_, _, _| false) {
            None => Vec::new(),
            Some(v) => v.into_iter().map(|b| b as i8).collect(),
        }
    }

    /// Fused image: `image(trans, qvars, subst) = (trans /\ self).exists(qvars).substitute(subst)`.
    ///
    /// For a transition relation `T(x, x')` and a current-state set `S(x)`:
    ///   next(x) = image(T(x, x'), S(x), {x_i : x}, rename x' -> x)
    ///
    /// Collapses three round-trips (and, exists, substitute) into one FFI call.
    /// Used by JS-side `reach` fixpoint loops; the fixpoint itself stays in
    /// JS per the design note.
    pub fn image(
        &self,
        trans: &BDD,
        qvars: &BDD,
        subst: &Substitution,
    ) -> Result<BDD, JsValue> {
        let conj = self
            .inner
            .and(&trans.inner)
            .map_err(|_| JsValue::from_str("image: out of memory in and"))?;
        let after_exists = conj
            .exists(&qvars.inner)
            .map_err(|_| JsValue::from_str("image: out of memory in exists"))?;
        after_exists
            .substitute(&subst.inner)
            .map(|f| BDD { inner: f })
            .map_err(|_| JsValue::from_str("image: out of memory in substitute"))
    }

    /// Fused preimage: apply substitution to `self` (mapping current -> next),
    /// conjoin with the transition, existentially quantify the next-state vars.
    ///
    /// prev(x) = preimage(T(x, x'), S(x'), {x_i' : x'}, rename x -> x')
    ///
    /// The substitution here renames current-state -> next-state vars (the
    /// opposite direction from image); JS-side `Context` manages this for you.
    pub fn preimage(
        &self,
        trans: &BDD,
        qvars: &BDD,
        subst: &Substitution,
    ) -> Result<BDD, JsValue> {
        let renamed = self
            .inner
            .substitute(&subst.inner)
            .map_err(|_| JsValue::from_str("preimage: out of memory in substitute"))?;
        let conj = renamed
            .and(&trans.inner)
            .map_err(|_| JsValue::from_str("preimage: out of memory in and"))?;
        conj.exists(&qvars.inner)
            .map(|f| BDD { inner: f })
            .map_err(|_| JsValue::from_str("preimage: out of memory in exists"))
    }
}

// ---------------------------------------------------------------------------
// Substitution: built once in Rust, reused across many `substitute` calls.
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct Substitution {
    inner: Subst<BDDFunction>,
}

#[wasm_bindgen]
impl Substitution {
    /// Number of variable substitutions in this mapping.
    pub fn var_count(&self) -> usize {
        use oxidd_core::util::Substitution as _;
        (&self.inner).pairs().len()
    }
}

/// Mutable builder for `Substitution`. Populate with `add(var_no, bdd)`
/// calls, then finalize with `build()`. Keeping this separate from
/// `Substitution` matches `oxidd::util::Subst`'s immutable-after-construction
/// design (an id is assigned at construction time and used for caching).
#[wasm_bindgen]
pub struct SubstitutionBuilder {
    vars: Vec<VarNo>,
    replacements: Vec<BDDFunction>,
}

#[wasm_bindgen]
impl SubstitutionBuilder {
    pub fn add(&mut self, var_no: u32, replacement: &BDD) {
        self.vars.push(var_no);
        self.replacements.push(replacement.inner.clone());
    }

    pub fn build(self) -> Substitution {
        Substitution {
            inner: Subst::new(self.vars, self.replacements),
        }
    }
}

// ---------------------------------------------------------------------------
// CommandBuffer: graphics-API-style batched BDD command recording.
//
// The caller records many BDD operations as a flat instruction stream on
// the JS side (zero FFI hops), binds any external BDDs and Substitutions
// it wants to reference, then submits the whole buffer via `BDDManager::submit`
// (one FFI hop total). Intermediate BDDs computed during execution exist
// only for the duration of the submit; only instruction results named in
// `outputs` are returned to the caller.
//
// Opcodes (see `Op::*` below for the authoritative list):
//
//   0x00  TRUE                            -> ⊤
//   0x01  FALSE                           -> ⊥
//   0x02  VAR    (a=var_no)               -> BDD for variable
//   0x03  BIND   (a=bind_idx)             -> clone of binds[bind_idx]
//   0x10  NOT    (a=idx)
//   0x11  AND    (a=idx, b=idx)
//   0x12  OR     (a=idx, b=idx)
//   0x13  XOR    (a=idx, b=idx)
//   0x14  IMP    (a=idx, b=idx)
//   0x15  EQUIV  (a=idx, b=idx)
//   0x16  ITE    (a=idx, b=idx, c=idx)
//   0x20  EXISTS (a=body, b=qvars)
//   0x21  FORALL (a=body, b=qvars)
//   0x22  SUBST  (a=body, b=subst_idx into subst_binds)
// ---------------------------------------------------------------------------

mod op {
    pub const TRUE:   u8 = 0x00;
    pub const FALSE:  u8 = 0x01;
    pub const VAR:    u8 = 0x02;
    pub const BIND:   u8 = 0x03;
    pub const NOT:    u8 = 0x10;
    pub const AND:    u8 = 0x11;
    pub const OR:     u8 = 0x12;
    pub const XOR:    u8 = 0x13;
    pub const IMP:    u8 = 0x14;
    pub const EQUIV:  u8 = 0x15;
    pub const ITE:    u8 = 0x16;
    pub const EXISTS: u8 = 0x20;
    pub const FORALL: u8 = 0x21;
    pub const SUBST:  u8 = 0x22;
}

#[wasm_bindgen]
pub struct CommandBuffer {
    ops: Vec<u8>,
    a: Vec<u32>,
    b: Vec<u32>,
    c: Vec<u32>,
    outputs: Vec<u32>,
    binds: Vec<BDDFunction>,
    subst_binds: Vec<Subst<BDDFunction>>,
}

#[wasm_bindgen]
impl CommandBuffer {
    /// Allocate an empty command buffer. No thread-pool or manager
    /// affinity yet: the buffer is executed against whichever manager
    /// receives the `submit` call.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            ops: Vec::new(),
            a: Vec::new(),
            b: Vec::new(),
            c: Vec::new(),
            outputs: Vec::new(),
            binds: Vec::new(),
            subst_binds: Vec::new(),
        }
    }

    /// Record the program. The four operand arrays are parallel to
    /// `ops` and must have the same length. Unused operands should be 0.
    /// `outputs` is the list of instruction indices the caller wants
    /// materialized as persistent BDD handles after `submit`.
    pub fn set_program(
        &mut self,
        ops: Vec<u8>,
        a: Vec<u32>,
        b: Vec<u32>,
        c: Vec<u32>,
        outputs: Vec<u32>,
    ) -> Result<(), JsValue> {
        let n = ops.len();
        if a.len() != n || b.len() != n || c.len() != n {
            return Err(JsValue::from_str(
                "CommandBuffer::set_program: ops/a/b/c length mismatch",
            ));
        }
        self.ops = ops;
        self.a = a;
        self.b = b;
        self.c = c;
        self.outputs = outputs;
        Ok(())
    }

    /// Bind an external BDD as a resource. Returns its bind index for
    /// use as operand `a` of a `BIND` op.
    pub fn bind_bdd(&mut self, bdd: &BDD) -> u32 {
        let idx = self.binds.len() as u32;
        self.binds.push(bdd.inner.clone());
        idx
    }

    /// Bind an external Substitution. Returns its index for use as
    /// operand `b` of a `SUBST` op.
    pub fn bind_subst(&mut self, subst: &Substitution) -> u32 {
        let idx = self.subst_binds.len() as u32;
        self.subst_binds.push(subst.inner.clone());
        idx
    }

    /// Number of recorded instructions.
    pub fn len(&self) -> usize {
        self.ops.len()
    }
}

impl CommandBuffer {
    /// Execute the buffer against `manager`. Returns one BDD per output
    /// index, in the same order as `self.outputs`.
    fn execute(&self, _manager: &BDDManager) -> Result<Vec<BDD>, JsValue> {
        // Scratch slot per instruction. We use Option so we can take() a
        // slot once it's no longer needed; keeps live node count smaller
        // during a large batch.
        //
        // Simpler, correct-first v0: keep everything live until the end.
        let n = self.ops.len();
        let mut slots: Vec<Option<BDDFunction>> = Vec::with_capacity(n);
        slots.resize_with(n, || None);

        // Cache true/false so consecutive TRUE/FALSE ops don't round-trip
        // through with_manager_shared. We materialize them lazily from the
        // first instruction that needs one.
        let mut t_const: Option<BDDFunction> = None;
        let mut f_const: Option<BDDFunction> = None;

        for i in 0..n {
            let op = self.ops[i];
            let a = self.a[i] as usize;
            let b = self.b[i] as usize;
            let c = self.c[i] as usize;

            let result: BDDFunction = match op {
                op::TRUE => {
                    if t_const.is_none() {
                        t_const = Some(_manager.inner.with_manager_shared(|m| BDDFunction::t(m)));
                    }
                    t_const.as_ref().unwrap().clone()
                }
                op::FALSE => {
                    if f_const.is_none() {
                        f_const = Some(_manager.inner.with_manager_shared(|m| BDDFunction::f(m)));
                    }
                    f_const.as_ref().unwrap().clone()
                }
                op::VAR => {
                    let var_no = self.a[i];
                    _manager.inner.with_manager_shared(|m| {
                        BDDFunction::var(m, var_no)
                            .map_err(|_| JsValue::from_str("VAR: out of memory"))
                    })?
                }
                op::BIND => {
                    let bind_idx = self.a[i] as usize;
                    self.binds
                        .get(bind_idx)
                        .ok_or_else(|| JsValue::from_str("BIND: index out of range"))?
                        .clone()
                }
                op::NOT => slot(&slots, a, "NOT.a")?.not()
                    .map_err(|_| JsValue::from_str("NOT: oom"))?,
                op::AND => slot(&slots, a, "AND.a")?.and(slot(&slots, b, "AND.b")?)
                    .map_err(|_| JsValue::from_str("AND: oom"))?,
                op::OR => slot(&slots, a, "OR.a")?.or(slot(&slots, b, "OR.b")?)
                    .map_err(|_| JsValue::from_str("OR: oom"))?,
                op::XOR => slot(&slots, a, "XOR.a")?.xor(slot(&slots, b, "XOR.b")?)
                    .map_err(|_| JsValue::from_str("XOR: oom"))?,
                op::IMP => slot(&slots, a, "IMP.a")?.imp(slot(&slots, b, "IMP.b")?)
                    .map_err(|_| JsValue::from_str("IMP: oom"))?,
                op::EQUIV => slot(&slots, a, "EQUIV.a")?.equiv(slot(&slots, b, "EQUIV.b")?)
                    .map_err(|_| JsValue::from_str("EQUIV: oom"))?,
                op::ITE => {
                    let ia = slot(&slots, a, "ITE.i")?;
                    let it = slot(&slots, b, "ITE.t")?;
                    let ie = slot(&slots, c, "ITE.e")?;
                    ia.ite(it, ie).map_err(|_| JsValue::from_str("ITE: oom"))?
                }
                op::EXISTS => slot(&slots, a, "EXISTS.body")?
                    .exists(slot(&slots, b, "EXISTS.qvars")?)
                    .map_err(|_| JsValue::from_str("EXISTS: oom"))?,
                op::FORALL => slot(&slots, a, "FORALL.body")?
                    .forall(slot(&slots, b, "FORALL.qvars")?)
                    .map_err(|_| JsValue::from_str("FORALL: oom"))?,
                op::SUBST => {
                    let body = slot(&slots, a, "SUBST.body")?;
                    let subst = self.subst_binds
                        .get(b)
                        .ok_or_else(|| JsValue::from_str("SUBST: subst index out of range"))?;
                    body.substitute(subst)
                        .map_err(|_| JsValue::from_str("SUBST: oom"))?
                }
                _ => return Err(JsValue::from_str(&format!("unknown opcode: 0x{:02x} at {}", op, i))),
            };

            slots[i] = Some(result);
        }

        // Materialize outputs.
        let mut out: Vec<BDD> = Vec::with_capacity(self.outputs.len());
        for &idx in &self.outputs {
            let f = slots.get(idx as usize)
                .and_then(|s| s.as_ref())
                .ok_or_else(|| JsValue::from_str("output index out of range"))?
                .clone();
            out.push(BDD { inner: f });
        }
        Ok(out)
    }
}

/// Internal: borrow the BDD at `slots[idx]`, error with `field` as hint.
fn slot<'a>(slots: &'a [Option<BDDFunction>], idx: usize, field: &str) -> Result<&'a BDDFunction, JsValue> {
    slots
        .get(idx)
        .and_then(|s| s.as_ref())
        .ok_or_else(|| JsValue::from_str(&format!("{}: index {} not yet defined", field, idx)))
}

// ---------------------------------------------------------------------------
// Native tests.
//
// These build and execute CommandBuffers against a real oxidd BDD manager
// on the host. They DON'T go through the JS/WASM boundary: the point is
// to catch bugs in the pure-Rust executor logic without the overhead and
// opacity of the browser round-trip.
//
// Run with: cargo +nightly test --lib
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: tiny IR-style builder for writing CommandBuffer tests
    /// without the JS-side bitblaster. Each method returns an instruction
    /// index into the buffer it's building.
    struct Prog {
        cb: CommandBuffer,
    }

    impl Prog {
        fn new() -> Self { Self { cb: CommandBuffer::new() } }

        fn push(&mut self, op: u8, a: u32, b: u32, c: u32) -> u32 {
            let idx = self.cb.ops.len() as u32;
            self.cb.ops.push(op);
            self.cb.a.push(a);
            self.cb.b.push(b);
            self.cb.c.push(c);
            idx
        }

        fn t(&mut self)                    -> u32 { self.push(op::TRUE, 0, 0, 0) }
        fn f(&mut self)                    -> u32 { self.push(op::FALSE, 0, 0, 0) }
        fn var(&mut self, v: u32)          -> u32 { self.push(op::VAR, v, 0, 0) }
        fn not(&mut self, a: u32)          -> u32 { self.push(op::NOT, a, 0, 0) }
        fn and(&mut self, a: u32, b: u32)  -> u32 { self.push(op::AND, a, b, 0) }
        fn or(&mut self, a: u32, b: u32)   -> u32 { self.push(op::OR, a, b, 0) }
        fn xor(&mut self, a: u32, b: u32)  -> u32 { self.push(op::XOR, a, b, 0) }
        fn equiv(&mut self, a: u32, b: u32) -> u32 { self.push(op::EQUIV, a, b, 0) }
        #[allow(dead_code)]
        fn exists(&mut self, body: u32, qvars: u32) -> u32 { self.push(op::EXISTS, body, qvars, 0) }
        #[allow(dead_code)]
        fn subst(&mut self, body: u32, subst_idx: u32) -> u32 { self.push(op::SUBST, body, subst_idx, 0) }

        fn set_outputs(&mut self, outs: Vec<u32>) {
            self.cb.outputs = outs;
        }

        fn run(self, mgr: &BDDManager) -> Vec<BDD> {
            self.cb.execute(mgr).expect("CommandBuffer::execute failed")
        }
    }

    fn new_mgr(threads: u32) -> BDDManager {
        BDDManager::new(1 << 16, 1 << 14, threads)
    }

    #[test]
    fn empty_buffer() {
        let mgr = new_mgr(1);
        let prog = Prog::new();
        let results = prog.run(&mgr);
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn basic_true_false() {
        let mgr = new_mgr(1);
        let mut p = Prog::new();
        let t = p.t();
        let f = p.f();
        p.set_outputs(vec![t, f]);
        let results = p.run(&mgr);
        assert_eq!(results.len(), 2);
        assert!(results[0].valid());
        assert!(!results[1].satisfiable());
    }

    #[test]
    fn var_and() {
        // (x0 AND x1) sat count should be 1 out of 4.
        let mgr = new_mgr(1);
        mgr.add_vars(2);

        let mut p = Prog::new();
        let x0 = p.var(0);
        let x1 = p.var(1);
        let conj = p.and(x0, x1);
        p.set_outputs(vec![conj]);

        let [r]: [BDD; 1] = p.run(&mgr).try_into().ok().unwrap();
        assert_eq!(r.sat_count(2), 1.0);
    }

    #[test]
    fn shared_subexpression_works() {
        // If we emit `VAR 0` twice at different indices, and AND them,
        // the executor should still produce x0 (since x0 AND x0 = x0).
        // This is a sanity check on the executor handling "same BDD
        // referenced from multiple slots" correctly.
        let mgr = new_mgr(1);
        mgr.add_vars(1);

        let mut p = Prog::new();
        let a = p.var(0);
        let b = p.var(0);
        let conj = p.and(a, b);
        p.set_outputs(vec![conj]);

        let [r]: [BDD; 1] = p.run(&mgr).try_into().ok().unwrap();
        assert_eq!(r.sat_count(1), 1.0);    // x0 satisfies half of 2^1
        // Node count should be just 1 (structure of `x0`).
        assert!(r.node_count() <= 3); // var + terminals
    }

    /// Build a left-associative AND chain of length `n`:
    ///   (((v0 AND v0) AND v0) AND v0) ...
    /// all over the same variable. Result should simplify to `v0`.
    /// This tests that the executor doesn't recurse on chain depth —
    /// executor walks the instruction array iteratively.
    #[test]
    fn deep_and_chain_does_not_stack_overflow() {
        let mgr = new_mgr(1);
        mgr.add_vars(1);

        // Run in a tiny-stack thread to make sure we don't have hidden
        // unbounded recursion in the executor.
        let result = std::thread::Builder::new()
            .stack_size(256 * 1024)  // 256 KiB
            .spawn(move || {
                let mut p = Prog::new();
                let x = p.var(0);
                let mut acc = x;
                for _ in 0..10_000 {
                    acc = p.and(acc, x);
                }
                p.set_outputs(vec![acc]);
                let [r]: [BDD; 1] = p.run(&mgr).try_into().ok().unwrap();
                r.sat_count(1)
            })
            .unwrap()
            .join()
            .unwrap();

        assert_eq!(result, 1.0);
    }

    /// Test that dropping a BDDManager after building a very deep BDD does
    /// not stack-overflow. This is the scenario we suspect is blowing up
    /// in the browser at k=10.
    #[test]
    fn manager_drop_after_deep_build_does_not_overflow() {
        let result = std::thread::Builder::new()
            .stack_size(256 * 1024)
            .spawn(|| {
                let mgr = new_mgr(1);
                mgr.add_vars(32);
                // Build a long chain of ANDs over many distinct variables.
                // This creates a BDD whose unique-table drop on manager
                // shutdown has to walk a long chain of nodes.
                let mut p = Prog::new();
                let mut acc = p.var(0);
                for v in 1..32 {
                    let vi = p.var(v);
                    acc = p.and(acc, vi);
                }
                p.set_outputs(vec![acc]);
                let [r]: [BDD; 1] = p.run(&mgr).try_into().ok().unwrap();
                let count = r.sat_count(32);
                // Drop everything explicitly here and let the manager
                // drop-chain run.
                drop(r);
                drop(mgr);
                count
            })
            .unwrap()
            .join()
            .unwrap();
        // x0 AND x1 AND ... x31 has exactly 1 satisfying assignment.
        assert_eq!(result, 1.0);
    }

    /// Build the multiplication relation x * y = z at various widths with
    /// a manually-constructed ripple-adder bitblaster, exercising the
    /// full CommandBuffer path end-to-end. Verifies both correctness
    /// (sat count = 2^(2*bits)) and that the executor doesn't blow the
    /// stack at large scales.
    fn mult_relation_impl(bits: u32, inner_cap: usize) {
        let mgr = BDDManager::new(inner_cap, inner_cap / 4, 1);
        mgr.add_vars(3 * bits);
        let xs: Vec<u32> = (0..bits).collect();
        let ys: Vec<u32> = (bits..2*bits).collect();
        let zs: Vec<u32> = (2*bits..3*bits).collect();

        let mut p = Prog::new();

        let t = p.t();
        let f = p.f();

        let xb: Vec<u32> = xs.iter().map(|&v| p.var(v)).collect();
        let yb: Vec<u32> = ys.iter().map(|&v| p.var(v)).collect();
        let zb: Vec<u32> = zs.iter().map(|&v| p.var(v)).collect();

        // Ripple-carry full adder
        let mut full_add = |p: &mut Prog, a: u32, b: u32, cin: u32| -> (u32, u32) {
            let axb = p.xor(a, b);
            let sum = p.xor(axb, cin);
            let aab = p.and(a, b);
            let caxb = p.and(cin, axb);
            let cout = p.or(aab, caxb);
            (sum, cout)
        };

        // k-bit adder mod 2^k
        let add_bits = |p: &mut Prog, xs: &[u32], ys: &[u32], f_const: u32| -> Vec<u32> {
            let mut out = Vec::with_capacity(xs.len());
            let mut carry = f_const;
            for i in 0..xs.len() {
                let (s, c) = full_add(p, xs[i], ys[i], carry);
                out.push(s);
                carry = c;
            }
            out
        };

        // Shift-and-add multiplier mod 2^k
        let mul_bits = |p: &mut Prog, xs: &[u32], ys: &[u32], f_const: u32| -> Vec<u32> {
            let k = xs.len();
            let mut acc: Vec<u32> = vec![f_const; k];
            for i in 0..k {
                let mut partial = Vec::with_capacity(k);
                for j in 0..k {
                    partial.push(if j < i { f_const } else { p.and(xs[j - i], ys[i]) });
                }
                acc = add_bits(p, &acc, &partial, f_const);
            }
            acc
        };

        let product = mul_bits(&mut p, &xb, &yb, f);

        // eqBits(product, zb)
        let mut eq_acc = t;
        for i in 0..bits as usize {
            let bit_eq = p.equiv(product[i], zb[i]);
            eq_acc = p.and(eq_acc, bit_eq);
        }

        p.set_outputs(vec![eq_acc]);
        let [rel]: [BDD; 1] = p.run(&mgr).try_into().ok().unwrap();

        // Expected: for each (x, y) pair there is exactly one z = x*y.
        // Over 3*bits variables, that's 2^(2*bits) sat.
        let expected = (1u64 << (2 * bits)) as f64;
        let count = rel.sat_count(3 * bits);
        assert_eq!(count, expected,
            "bits={}: expected {} satisfying assignments", bits, expected);
    }

    #[test]
    fn mult_relation_k4() { mult_relation_impl(4, 1 << 14); }

    #[test]
    fn mult_relation_k7() { mult_relation_impl(7, 1 << 17); }

    #[test]
    fn mult_relation_k10() { mult_relation_impl(10, 1 << 20); }

    /// Reproduction target: browser demo at k=10 blew the wasm stack
    /// with the 1 MiB default. On native, try progressively tinier
    /// stacks to find the depth of our worst-case recursion. WASM
    /// typically uses 5-10× more stack per frame than native due to
    /// calling convention and the linear-memory frame pointer, so
    /// if native needs S bytes, wasm likely needs 5-10× S.
    #[test]
    fn mult_relation_k10_stack_512k() {
        std::thread::Builder::new()
            .stack_size(512 * 1024)
            .spawn(|| mult_relation_impl(10, 1 << 20))
            .unwrap()
            .join()
            .unwrap();
    }

    #[test]
    fn mult_relation_k10_stack_256k() {
        std::thread::Builder::new()
            .stack_size(256 * 1024)
            .spawn(|| mult_relation_impl(10, 1 << 20))
            .unwrap()
            .join()
            .unwrap();
    }

    #[test]
    fn mult_relation_k10_stack_128k() {
        std::thread::Builder::new()
            .stack_size(128 * 1024)
            .spawn(|| mult_relation_impl(10, 1 << 20))
            .unwrap()
            .join()
            .unwrap();
    }

    #[test]
    fn image_preimage_single_step() {
        // 2-bit transition: x' = x + 1 (mod 4). Starting from x = 0,
        // one image step should give {x = 1}.
        let bits: u32 = 2;
        let mgr = new_mgr(1);
        mgr.add_vars(2 * bits); // x_0, x_1, x'_0, x'_1
        // vars: 0, 1 = x;  2, 3 = x'

        let mut p = Prog::new();
        let _t = p.t();
        let _f = p.f();

        let x0 = p.var(0); let x1 = p.var(1);
        let xp0 = p.var(2); let xp1 = p.var(3);

        // init: x = 0  ->  ~x0 /\ ~x1
        let nx0 = p.not(x0);
        let nx1 = p.not(x1);
        let init_ir = p.and(nx0, nx1);

        // x + 1 (mod 4):
        //   s0 = x0 XOR 1 = ~x0
        //   cout0 = x0 AND 1 = x0
        //   s1 = x1 XOR cout0 = x1 XOR x0
        let s0 = p.not(x0);
        let s1 = p.xor(x1, x0);

        // trans: x'_0 == s0  /\  x'_1 == s1
        let eq0 = p.equiv(xp0, s0);
        let eq1 = p.equiv(xp1, s1);
        let trans_ir = p.and(eq0, eq1);

        // qvars (x) = x0 AND x1
        let qvars_ir = p.and(x0, x1);

        p.set_outputs(vec![init_ir, trans_ir, qvars_ir]);
        let results = p.run(&mgr);
        let init_bdd = &results[0];
        let trans_bdd = &results[1];
        let qvars_bdd = &results[2];

        // Build subst x'_i -> x_i using SubstitutionBuilder directly.
        let mut sb = mgr.new_substitution_builder();
        // We need BDDs for var 0 and var 1 (the replacements).
        let x0_bdd = mgr.var(0).unwrap();
        let x1_bdd = mgr.var(1).unwrap();
        sb.add(2, &x0_bdd);
        sb.add(3, &x1_bdd);
        let subst = sb.build();

        // image: subst(exists(init /\ trans, qvars), x' -> x).
        let image = init_bdd.image(trans_bdd, qvars_bdd, &subst).unwrap();
        // Should be x = 1, i.e. x0 /\ ~x1. Count over 4 vars = 2^2 "don't cares in x'" = 4.
        // But if we ask sat_count over just 2 vars, we get 1.
        // Actually sat_count uses manager-wide vars = 4. So we expect 2^2 = 4 (image does not
        // depend on x', so each x' assignment is a don't-care).
        let c = image.sat_count(4);
        assert_eq!(c, 4.0, "image(x=0) should be x=1 (4 sat assignments over 4 vars)");

        // count_with_nvars(2, 4) should give 1.
        let c2 = image.count_with_nvars(2, 4).unwrap();
        assert_eq!(c2, 1.0, "care-set count should be 1");
    }
}
