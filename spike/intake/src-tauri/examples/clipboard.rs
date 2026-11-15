fn main() -> std::process::ExitCode {
    if let Some(code) = rapidraw_intake_spike::worker_entry() {
        return std::process::ExitCode::from(code as u8);
    }
    let argument = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "compare".to_owned());
    if argument == "--guarded" {
        let mode = std::env::args()
            .nth(2)
            .unwrap_or_else(|| "prefer-png".to_owned());
        return match rapidraw_intake_spike::ImageReadMode::try_from(mode.as_str()) {
            Ok(mode) => {
                let gate = rapidraw_intake_spike::ClipboardReadGate::default();
                println!(
                    "{}",
                    rapidraw_intake_spike::read_guarded(
                        mode,
                        rapidraw_intake_spike::PROVISIONAL_FOCUS_GUARD,
                        &gate,
                    )
                );
                std::process::ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("{error}");
                std::process::ExitCode::FAILURE
            }
        };
    }
    match rapidraw_intake_spike::ImageReadMode::try_from(argument.as_str()) {
        Ok(mode) => {
            println!("{}", rapidraw_intake_spike::read_clipboard_with_mode(mode));
            std::process::ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::ExitCode::FAILURE
        }
    }
}
