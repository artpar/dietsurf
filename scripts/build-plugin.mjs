#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, chmod, copyFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const chromePath =
  process.env.CHROME_PATH ||
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "");
const stage = path.join(root, "tmp", "plugin-src");
const crxOut = path.join(root, "plugin.crx");
const pemOut = path.join(root, "plugin.pem");

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
  const to = path.join(stage, file);
  await mkdir(path.dirname(to), { recursive: true });
  await copyFile(from, to);
}

if (!chromePath) throw new Error("set CHROME_PATH");

await run("npm", ["run", "build"]);
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
for (const file of files) await copyIntoStage(file);

const args = [`--pack-extension=${stage}`];
if (await exists(pemOut)) args.push(`--pack-extension-key=${pemOut}`);
await run(chromePath, args);

const packedCrx = `${stage}.crx`;
const packedPem = `${stage}.pem`;
await copyFile(packedCrx, crxOut);
if (!(await exists(pemOut)) && await exists(packedPem)) await copyFile(packedPem, pemOut);
if (await exists(pemOut)) await chmod(pemOut, 0o600);

const { size } = await stat(crxOut);
await rm(path.dirname(stage), { recursive: true, force: true });

console.log(`built ${path.relative(root, crxOut)} (${Math.round(size / 1024)} KiB)`);
if (await exists(pemOut)) console.log(`using ${path.relative(root, pemOut)} for stable extension id`);
