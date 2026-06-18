#!/usr/bin/env node
import "dotenv/config";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime } from "../kernel.js";
import { createPuppeteerChrome } from "../src/runtime/chrome-puppeteer.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function disk(path) {
  return join(root, path.replace(/^\/+/, ""));
}

async function listAll(dir) {
  const out = [];
  async function walk(abs, prefix) {
    const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(abs, entry.name), path);
      else out.push(path);
    }
  }
  await walk(disk(dir), dir === "/" ? "" : dir.replace(/\/$/, ""));
  return out;
}

const fsRuntime = {
  readFile: (path) => readFile(disk(path), "utf8"),
  async writeFile(path, text) {
    await mkdir(dirname(disk(path)), { recursive: true });
    await writeFile(disk(path), text, "utf8");
  },
  listFiles: (path = "/") => listAll(path),
  removeFile: (path) => rm(disk(path), { force: true })
};

const browserConfig = JSON.parse(await fsRuntime.readFile("/etc/browser.json"));
const chrome = await createPuppeteerChrome(browserConfig);

try {
  const runtime = createRuntime({
    ...fsRuntime,
    chrome,
    env: process.env,
    clearHistory: () => fsRuntime.writeFile("/var/log/history.jsonl", ""),
    log: (...args) => console.log(...args)
  });
  const result = await runtime.runFile("/src/agent.js", process.argv.slice(2));
  if (result) console.log(result);
} finally {
  await chrome.close();
}
