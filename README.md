# Bilin

> **[Read in Japanese (日本語) 🇯🇵](./README_ja.md)**

Bilin is a desktop application designed to bridge the gap for non-native English speakers trying to read long-form international news, blogs, and articles. It provides a side-by-side reading layout, powered by AI translation and Text-to-Speech (TTS), helping you learn and comprehend at your own pace.

## 🚀 Key Features

- **Side-by-Side Reading**: View the original website layout in the center pane while interacting with extracted text cards on the right.
- **Paragraph-Level Translation**: Translate text paragraph-by-paragraph using the OpenAI Chat API (`gpt-4o-mini`) for highly accurate context-aware meanings.
- **Native Pronunciation TTS**: Click "Listen" to hear the original text spoken naturally using OpenAI's TTS API.
- **Cost-efficient Local Caching**: Translated text and audio binaries are automatically saved in the browser's IndexedDB. Revisiting them costs $0 and has zero latency.
- **Multi-Tab Sessions**: Read multiple articles concurrently. Your reading state and tabs persist securely across app restarts.
- **Bring Your Own Key (BYOK)**: Bilin runs exclusively on your personal API key stored securely in local storage, guaranteeing privacy and transparency.

---

## 📦 Installation

There are two primary ways to run Bilin on your computer.

### Option 1: Download Pre-built Binaries (Recommended)
Every release is automatically built for Windows, macOS, and Linux thanks to GitHub Actions.
1. Go to the project's [Releases tab](../../releases).
2. Download the suitable installer for your operating system:
   - **Windows**: Download the `.msi` or `.exe` file.
   - **macOS**: Download the `.dmg` file.
   - **Linux**: Download the `.AppImage` or `.deb` packages.
3. Install and run the app safely.

### Option 2: Build from Source
For developers, you can build the application locally from the source code. You will need **Node.js** and the **Rust Toolchain** installed on your system.

```bash
# 1. Clone the repository
git clone https://github.com/bitbears-dev/bilin.git
cd bilin

# 2. Install Node dependencies
npm install

# 3. Run the development server & Tauri app
npm run tauri dev

# 4. (Optional) Build the final executable for your current OS
npm run tauri build
```

---

## 📖 How to Use

1. **Setup API Key**: On the bottom left of the sidebar, click the **Settings (Gear Icon)**. Input your personal OpenAI API Key and hit 'Save'.
2. **Open an Article**: In the top address bar, paste the URL of the English news or blog you want to read, and hit **"開く"** (Open).
3. **Learn Interactively**: The parsed article text will appear on the right side as paragraph cards.
   - Click **"翻訳を表示" (Translate)** if you're stuck on the meaning.
   - Click **"Listen"** to listen to the proper pronunciation.
4. **Manage Multiple Readings**: Click the **"+" (Plus icon)** on the left vertical sidebar to open an empty new tab without losing your existing progress.

---

**Built with:** [Tauri v2](https://v2.tauri.app/), React, Tailwind CSS, Rust, and OpenAI.
