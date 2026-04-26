#![allow(clippy::must_use_candidate)]

use oxidd::bdd::{BDDFunction, BDDManagerRef};
use oxidd::{BooleanFunction, BooleanFunctionQuant, Function, Manager, ManagerRef};
use oxidd::util::num::F64;
use oxidd_core::util::SatCountCache;
use oxidd_core::LevelNo;
use std::hash::BuildHasherDefault;
use rustc_hash::FxHasher;
use wasm_bindgen::prelude::*;

pub use wasm_bindgen_rayon::init_thread_pool;

#[wasm_bindgen(js_name = "setPanicHook")]
pub fn set_panic_hook() {
    console_error_panic_hook::set_once();
}

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
        self.inner
            .with_manager_exclusive(|m| {
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

    pub fn var(&self, var_no: u32) -> Result<BDD, JsValue> {
        self.inner
            .with_manager_shared(|m| {
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
}

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

    pub fn sat_count(&self, num_vars: u32) -> f64 {
        let mut cache = SatCountCache::<F64, BuildHasherDefault<FxHasher>>::default();
        self.inner.sat_count(num_vars as LevelNo, &mut cache).0
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
}
