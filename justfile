# OxiDD WASM bindings
# Prerequisites:
#   rustup toolchain install nightly
#   rustup component add rust-src --toolchain nightly
#   rustup target add wasm32-unknown-unknown --toolchain nightly
#   cargo install wasm-pack
#   git submodule update --init --recursive

set shell := ["bash", "-c"]

WASM_CRATE := "crates/oxidd-wasm"
OUT_DIR := "../../www/pkg"

RUSTFLAGS := "-C link-arg=--import-memory -C link-arg=--max-memory=4294967296 -C link-arg=-zstack-size=8388608"

# Build WASM (release by default; pass --dev for debug). Stable Rust:
# we no longer need nightly because we dropped `parking_lot/nightly`
# and `-Z build-std` (the latter was only needed for wasm-bindgen-rayon's
# shared-memory atomics).
build *FLAGS:
    export PATH="$HOME/.cargo/bin:$PATH"
    export RUSTFLAGS='{{RUSTFLAGS}}'
    wasm-pack build {{WASM_CRATE}} \
      --target web \
      --out-dir {{OUT_DIR}} \
      {{FLAGS}}

build-release: (build "--release")

build-dev: (build "--dev")

# Build with release-level optimizations + DWARF debuginfo so Chrome
# DevTools can symbolicate wasm-function[NNN] back to Rust. Use this
# for profiling; don't ship to Pages (files are ~3-5x larger).
# Requires Chrome "WebAssembly Debugging: Enable DWARF support"
# experiment (chrome://flags/#enable-webassembly-debugging).
build-profiling: (build "--profiling")

# Start the demo server with COOP/COEP headers
serve PORT="8080": build-release
    python3 www/serve.py {{PORT}}

# Type-check only, no build
check:
    export PATH="$HOME/.cargo/bin:$PATH"
    export RUSTFLAGS='{{RUSTFLAGS}}'
    cd {{WASM_CRATE}} && cargo check --target wasm32-unknown-unknown -Z build-std=panic_abort,std

# Clean build artifacts
clean:
    rm -rf {{WASM_CRATE}}/target www/pkg
