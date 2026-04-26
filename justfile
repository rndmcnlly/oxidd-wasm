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

RUSTFLAGS := "-C target-feature=+atomics,+bulk-memory,+mutable-globals -C link-arg=--import-memory -C link-arg=--shared-memory -C link-arg=--max-memory=4294967296 -C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size -C link-arg=--export=__tls_align -C link-arg=--export=__tls_base -C link-arg=-zstack-size=8388608"

# Build WASM (release by default; pass --dev for debug)
build *FLAGS:
    export PATH="$HOME/.cargo/bin:$PATH"
    export RUSTFLAGS='{{RUSTFLAGS}}'
    wasm-pack build {{WASM_CRATE}} \
      --target web \
      --out-dir {{OUT_DIR}} \
      {{FLAGS}} \
      -- -Z build-std=panic_abort,std

build-release: (build "--release")

build-dev: (build "--dev")

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
