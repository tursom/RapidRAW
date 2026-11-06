fn main() {
    for (variable, name) in [
        ("PROFILE", "SPIKE_CARGO_PROFILE"),
        ("OPT_LEVEL", "SPIKE_OPT_LEVEL"),
    ] {
        println!(
            "cargo:rustc-env={name}={}",
            std::env::var(variable).expect("Cargo build metadata")
        );
    }
    #[cfg(feature = "desktop")]
    tauri_build::build();
}
