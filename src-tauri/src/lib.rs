// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn fetch_html(url: String) -> Result<String, String> {
    let client = reqwest::Client::new();
    client
        .get(&url)
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )
        .send()
        .await
        .map_err(|e| format!("Failed to fetch: {}", e))?
        .text()
        .await
        .map_err(|e| format!("Failed to read text: {}", e))
}

#[tauri::command]
async fn fetch_html_jina(url: String) -> Result<String, String> {
    let client = reqwest::Client::new();
    let jina_url = format!("https://r.jina.ai/{}", url);
    client
        .get(&jina_url)
        .header("X-Return-Format", "html")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch from Jina: {}", e))?
        .text()
        .await
        .map_err(|e| format!("Failed to read text from Jina: {}", e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet, fetch_html, fetch_html_jina])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
