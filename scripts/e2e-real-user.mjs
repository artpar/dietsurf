#!/usr/bin/env node
import "dotenv/config";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const root = process.cwd();
const chromePath =
  process.env.CHROME_PATH ||
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, shell: true, stdio: "inherit" });
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited ${code}`)));
  });
}

async function readLog(page) {
  return page.$eval("#dietsurf-log", (el) => el.textContent);
}

async function waitForLog(page, text, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const log = await readLog(page);
    if (log.includes(text)) return log;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`timed out waiting for ${text}`);
}

if (!chromePath) throw new Error("set CHROME_PATH");
if (!process.env.LILAC_API_KEY) throw new Error("missing LILAC_API_KEY in .env");

await run("npm", ["run", "build"]);

const userDataDir = await mkdtemp(join(tmpdir(), "dietsurf-real-user-"));
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  pipe: true,
  userDataDir,
  enableExtensions: [root],
  args: ["--no-first-run", "--no-default-browser-check"]
});

try {
  const workerTarget = await browser.waitForTarget(
    (target) => target.type() === "service_worker" && target.url().includes("/dist/worker.js"),
    { timeout: 10000 }
  );
  const extensionId = new URL(workerTarget.url()).host;

  const target = await browser.newPage();
  await target.goto("https://example.com", { waitUntil: "domcontentloaded" });
  await target.bringToFront();

  const panel = await browser.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: "networkidle0" });
  await panel.waitForSelector("#dietsurf-prompt", { timeout: 10000 });

  const seed = await panel.evaluate((apiKey) => chrome.runtime.sendMessage({
    type: "writeFile",
    path: "/etc/llm.json",
    text: JSON.stringify({
      baseUrl: "https://api.getlilac.com/v1",
      apiKey,
      apiKeyEnv: "LILAC_API_KEY",
      model: "minimaxai/minimax-m2.7"
    }, null, 2)
  }), process.env.LILAC_API_KEY);
  if (!seed?.ok) throw new Error(seed?.error || "failed to seed /etc/llm.json");

  await panel.bringToFront();
  await panel.click("#dietsurf-prompt");
  await panel.keyboard.type('node /src/agent.js "read the active tab title and return only the title"', { delay: 2 });
  await panel.keyboard.press("Enter");
  await target.bringToFront();

  const log = await waitForLog(panel, "Example Domain");
  console.log(JSON.stringify({ ok: true, extensionId, logTail: log.slice(-2000) }, null, 2));
} finally {
  await browser.close();
  await rm(userDataDir, { recursive: true, force: true });
}
