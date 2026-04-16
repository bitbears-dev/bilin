// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn fetch_html(url: String) -> Result<String, String> {
    reqwest::get(&url)
        .await
        .map_err(|e| format!("Failed to fetch: {}", e))?
        .text()
        .await
        .map_err(|e| format!("Failed to read text: {}", e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet, fetch_html])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
