fn main() -> std::process::ExitCode {
    let argument = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "compare".to_owned());
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
