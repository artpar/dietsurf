#!/usr/bin/env node
import "dotenv/config";
import { spawn } from "node:child_process";
import { access, chmod, copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const root = process.cwd();
const chromePath =
  process.env.CHROME_PATH ||
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "");
const buildDir = path.join(root, "build");
const unpacked = path.join(buildDir, "unpacked");
const packSrc = path.join(buildDir, "pack-src");
const crxOut = path.join(buildDir, "plugin.crx");
const keyDir = process.env.DIETSURF_KEY_DIR || path.join(homedir(), ".dietsurf");
const pemOut = process.env.DIETSURF_PLUGIN_KEY || path.join(keyDir, "plugin.pem");

const files = [
  "manifest.json",
  "sidepanel.html",
  "dist/worker.js",
  "dist/sidepanel.js",
  "package.json",
  "bin/dietsurf-node.js",
  "etc/llm.json",
  "etc/browser.json",
  "etc/profile",
  "src/agent.js",
  "src/runtime/chrome-puppeteer.js",
  "src/ui.css",
  "var/log/history.jsonl",
  "home/user/notes.md"
];

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function copyIntoStage(file) {
  const from = path.join(root, file);
  const to = path.join(unpacked, file);
  await mkdir(path.dirname(to), { recursive: true });
  await copyFile(from, to);
}

async function injectLocalLlmKey(dir) {
  if (!process.env.LILAC_API_KEY) return false;
  await writeFile(path.join(dir, "etc", "llm.json"), JSON.stringify({
    baseUrl: "https://api.getlilac.com/v1",
    apiKey: process.env.LILAC_API_KEY,
    apiKeyEnv: "LILAC_API_KEY",
    model: "minimaxai/minimax-m2.7"
  }, null, 2));
  return true;
}

if (!chromePath) throw new Error("set CHROME_PATH");

await run("npm", ["run", "build"]);
await rm(buildDir, { recursive: true, force: true });
await mkdir(unpacked, { recursive: true });
await mkdir(keyDir, { recursive: true });
for (const file of files) await copyIntoStage(file);
const injectedKey = await injectLocalLlmKey(unpacked);
await rm(packSrc, { recursive: true, force: true });
await mkdir(path.dirname(packSrc), { recursive: true });
for (const file of files) {
  const from = path.join(unpacked, file);
  const to = path.join(packSrc, file);
  await mkdir(path.dirname(to), { recursive: true });
  await copyFile(from, to);
}
await injectLocalLlmKey(packSrc);

const args = [`--pack-extension=${packSrc}`];
if (await exists(pemOut)) args.push(`--pack-extension-key=${pemOut}`);
await run(chromePath, args);

const packedCrx = `${packSrc}.crx`;
const packedPem = `${packSrc}.pem`;
await copyFile(packedCrx, crxOut);
if (!(await exists(pemOut)) && await exists(packedPem)) await copyFile(packedPem, pemOut);
if (await exists(pemOut)) await chmod(pemOut, 0o600);
await rm(packSrc, { recursive: true, force: true });
await rm(packedCrx, { force: true });
await rm(packedPem, { force: true });

const { size } = await stat(crxOut);

console.log(`built ${path.relative(root, crxOut)} (${Math.round(size / 1024)} KiB)`);
console.log(`load unpacked from ${path.relative(root, unpacked)}`);
if (injectedKey) console.log("injected LILAC_API_KEY into ignored build artifacts");
if (await exists(pemOut)) console.log(`using signing key ${pemOut}`);
