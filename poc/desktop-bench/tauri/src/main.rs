// Throwaway envelope; no replacement of the existing Go backend.
fn main() {
    let url = std::env::args()
        .find(|arg| arg.starts_with("http://127.0.0.1:"))
        .expect("Missing local benchmark URL");
    tauri::Builder::default()
        .setup(move |app| {
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(url.parse()?),
            )
            .title("ghl desktop benchmark — Tauri")
            // This macOS build includes a 32px title bar in this size.
            // The harness verifies the actual webview is 1280x720.
            .inner_size(1280.0, 752.0)
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Failed to run benchmark window")
}
