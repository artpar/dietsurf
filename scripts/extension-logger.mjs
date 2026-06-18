#!/usr/bin/env node
import "dotenv/config";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const root = process.cwd();
const extensionRoot = path.join(root, "build", "unpacked");
const session = new Date().toISOString().replace(/[:.]/g, "-");
const logsDir = path.join(root, "logs", session);
const chromePath =
  process.env.CHROME_PATH ||
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "");

await mkdir(logsDir, { recursive: true });

const streams = {
  all: createWriteStream(path.join(logsDir, "all.jsonl")),
  console: createWriteStream(path.join(logsDir, "console.jsonl")),
  errors: createWriteStream(path.join(logsDir, "errors.jsonl")),
  network: createWriteStream(path.join(logsDir, "network.jsonl"))
};
const attachedPages = new WeakSet();
const pageLabels = new WeakMap();

function write(category, data) {
  const line = JSON.stringify({ ts: new Date().toISOString(), category, ...data }) + "\n";
  streams[category]?.write(line);
  streams.all.write(line);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, shell: true, stdio: "inherit" });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

async function attachPage(page, label) {
  pageLabels.set(page, label);
  if (attachedPages.has(page)) return;
  attachedPages.add(page);
  const source = () => pageLabels.get(page) || label;
  page.on("console", (msg) => {
    write("console", {
      source: source(),
      level: msg.type(),
      text: msg.text(),
      location: msg.location(),
      url: page.url()
    });
  });
  page.on("pageerror", (error) => {
    write("errors", { source: source(), error: error.stack || String(error), url: page.url() });
  });
  page.on("request", (request) => {
    write("network", { source: source(), type: "request", method: request.method(), url: request.url() });
  });
  page.on("response", (response) => {
    write("network", { source: source(), type: "response", status: response.status(), url: response.url() });
  });
}

async function attachWorker(target) {
  const session = await target.createCDPSession();
  await session.send("Runtime.enable");
  session.on("Runtime.consoleAPICalled", (event) => {
    write("console", {
      source: "service-worker",
      level: event.type,
      args: event.args,
      stackTrace: event.stackTrace,
      url: target.url()
    });
  });
  session.on("Runtime.exceptionThrown", (event) => {
    write("errors", { source: "service-worker", exception: event.exceptionDetails, url: target.url() });
  });
}

async function attachTarget(target) {
  const type = target.type();
  const url = target.url();
  write("console", { source: "target", type, url });
  if (type === "service_worker" && url.includes("/runtime/worker.js")) await attachWorker(target);
  if (type === "page") {
    const page = await target.page();
    if (page) await attachPage(page, url.startsWith("chrome-extension://") ? "extension-page" : "page");
  }
}

console.log(`logs: ${logsDir}`);
console.log("building extension");
await run("npm", ["run", "build"]);

if (!chromePath) throw new Error("set CHROME_PATH");

const userDataDir =
  process.env.CHROME_USER_DATA_DIR ||
  (await mkdtemp(path.join(tmpdir(), "dietsurf-chrome-")));

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  pipe: true,
  userDataDir,
  enableExtensions: [extensionRoot],
  args: ["--no-first-run", "--no-default-browser-check"]
});

browser.on("targetcreated", (target) => attachTarget(target).catch((error) => write("errors", { error: String(error) })));
for (const target of browser.targets()) await attachTarget(target);

const workerTarget = await browser.waitForTarget(
  (target) => target.type() === "service_worker" && target.url().includes("/runtime/worker.js"),
  { timeout: 10000 }
);
const extensionId = new URL(workerTarget.url()).host;
const page = await browser.newPage();
await attachPage(page, "sidepanel");
await page.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: "networkidle0" });
await page.waitForSelector("#dietsurf-main-host");
if (process.env.LILAC_API_KEY) {
  const response = await page.evaluate((apiKey) => Promise.all(["main", "staging"].map((workspace) => (
    chrome.runtime.sendMessage({
      type: "writeFile",
      path: `/${workspace}/etc/llm.json`,
      text: JSON.stringify({
        baseUrl: "https://api.getlilac.com/v1",
        apiKey,
        apiKeyEnv: "LILAC_API_KEY",
        model: "minimaxai/minimax-m2.7"
      }, null, 2)
    })
  ))), process.env.LILAC_API_KEY);
  const failed = response.find((item) => !item?.ok);
  if (failed) throw new Error(failed?.error || "failed to seed llm config");
  console.log("seeded /main/etc/llm.json and /staging/etc/llm.json from LILAC_API_KEY");
}

console.log(`extension: chrome-extension://${extensionId}/sidepanel.html`);
console.log("press Ctrl+C to stop");

async function close() {
  await browser.close();
  if (!process.env.CHROME_USER_DATA_DIR) await rm(userDataDir, { recursive: true, force: true });
  Object.values(streams).forEach((stream) => stream.end());
  console.log(`logs saved: ${logsDir}`);
}

process.on("SIGINT", async () => {
  await close();
  process.exit(0);
});

if (process.env.ONCE === "1") {
  await close();
} else {
  await new Promise(() => {});
}
