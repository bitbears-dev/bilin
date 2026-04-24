# Bilin

> **[Read in Japanese (日本語) 🇯🇵](./README_ja.md)**

Bilin is a desktop application designed to bridge the gap for non-native English speakers trying to read long-form international news, blogs, and articles. It provides a side-by-side reading layout, powered by AI translation and Text-to-Speech (TTS), helping you learn and comprehend at your own pace.

## 🚀 Key Features

- **Side-by-Side Reading**: View the original website layout in the center pane while interacting with extracted text cards on the right.
- **Paragraph-Level Translation**: Translate text paragraph-by-paragraph using your choice of AI providers (OpenAI, Gemini, or Claude) for highly accurate context-aware meanings.
- **Native Pronunciation TTS**: Click "Listen" to hear the original text spoken naturally using OpenAI or Gemini TTS.
- **Cost-efficient Local Caching**: Translated text and audio binaries are automatically saved in the browser's IndexedDB. Revisiting them costs $0 and has zero latency.
- **Multi-Tab Sessions**: Read multiple articles concurrently. Your reading state, tabs, and scroll positions persist securely across app restarts.
- **Bring Your Own Key (BYOK)**: Bilin runs exclusively on your personal API keys stored securely in local storage, guaranteeing privacy and transparency.

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

1. **Setup API Key & Models**: On the bottom left of the sidebar, click the **Settings (Gear Icon)**. 
   - Select your preferred AI Provider (OpenAI, Gemini, or Claude) for translation, enter your API Key, and choose a model.
   - Select your preferred TTS Provider (OpenAI or Gemini) for text-to-speech, enter your API Key, and choose a model. Hit 'Save'.
2. **Open an Article**: In the top address bar, paste the URL of the English news or blog you want to read, and hit **"開く"** (Open).
3. **Learn Interactively**: The parsed article text will appear on the right side as paragraph cards.
   - Click **"翻訳" (Translate)** if you're stuck on the meaning.
   - Click **"Listen"** to hear the proper pronunciation. You can **Pause** or **Stop** the audio anytime.
   - Enable **Auto Translate** in the top bar of the right pane to automatically translate cards as they become visible while scrolling.
   - Click on any paragraph directly within the original website (center pane) to automatically scroll and focus its corresponding translation card on the right.
4. **Manage Multiple Readings**: Click the **"+" (Plus icon)** on the left vertical sidebar to open an empty new tab without losing your existing progress. Your scroll positions inside the original website and the translation cards are securely preserved even across tabs!

---

## 🚢 Release Process

To release a new version of Bilin, we use npm's built-in versioning system which automatically updates all necessary files and tags the release for GitHub Actions.

1. Ensure your working directory is clean (`git status` shows no uncommitted changes).
2. Run the following command to bump the version (e.g., to `1.2.3`):
   ```bash
   npm version 1.2.3
   ```
   *This command automatically:*
   - *Updates `package.json` and `package-lock.json`.*
   - *Updates `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.*
   - *Commits all these changes and creates a Git tag `v1.2.3`.*
3. Push the commit and the tags to the remote repository:
   ```bash
   git push origin main --tags
   ```
4. GitHub Actions will automatically trigger the `Release` workflow, build binaries for Windows, macOS, and Linux, and draft a new release on the Releases page.

---

**Built with:** [Tauri v2](https://v2.tauri.app/), React, Tailwind CSS, Rust, and OpenAI.
