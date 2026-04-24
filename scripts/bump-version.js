import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// package.json は npm version によって既に更新されている
const packageJsonPath = path.join(__dirname, '../package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const version = packageJson.version;

// src-tauri/tauri.conf.json の更新
const tauriConfPath = path.join(__dirname, '../src-tauri/tauri.conf.json');
let tauriConf = fs.readFileSync(tauriConfPath, 'utf8');
tauriConf = tauriConf.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`);
fs.writeFileSync(tauriConfPath, tauriConf);

// src-tauri/Cargo.toml の更新
const cargoTomlPath = path.join(__dirname, '../src-tauri/Cargo.toml');
let cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
cargoToml = cargoToml.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`);
fs.writeFileSync(cargoTomlPath, cargoToml);

// Cargo.lock の更新
console.log('Updating Cargo.lock...');
execSync('cargo update -p tauri-app', { cwd: path.join(__dirname, '../src-tauri'), stdio: 'inherit' });

console.log(`Updated tauri.conf.json, Cargo.toml, and Cargo.lock to version ${version}`);
