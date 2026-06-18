import Dexie from "dexie";
import { PROJECT_FILES, createRuntime, toErrorText } from "./kernel.js";

const STORE = "dietsurf.files";
const db = new Dexie("dietsurf");
db.version(1).stores({ files: "path" });

async function allFiles() {
  const rows = await db.files.toArray();
  return Object.fromEntries(rows.map((row) => [row.path, row.text]));
}

async function readFile(path) {
  const file = await db.files.get(path);
  if (!file) throw new Error(`no such file: ${path}`);
  return file.text;
}

async function writeFile(path, text) {
  await db.files.put({ path, text: String(text) });
}

async function listFiles(path = "/") {
  const files = await allFiles();
  const prefix = path === "/" ? "/" : `${path.replace(/\/$/, "")}/`;
  return Object.keys(files).filter((file) => file === path || file.startsWith(prefix));
}

async function removeFile(path) {
  await db.files.delete(path);
}

async function migrateChromeStorage() {
  const data = await chrome.storage.local.get(STORE);
  const files = data[STORE] || {};
  const paths = Object.keys(files);
  if (!paths.length) return;
  await db.files.bulkPut(paths.map((path) => ({ path, text: String(files[path]) })));
  await chrome.storage.local.remove(STORE);
}

async function seedFiles() {
  await migrateChromeStorage();
  if (await db.files.get("/src/agent.js")) return;
  const files = [];
  for (const path of PROJECT_FILES) {
    const url = chrome.runtime.getURL(path.slice(1));
    const response = await fetch(url);
    files.push({ path, text: response.ok ? await response.text() : "" });
  }
  await db.files.bulkPut(files);
}

function chromeFacade() {
  return {
    tabs: chrome.tabs,
    scripting: {
      executeScript(details) {
        if (!details || typeof details.func !== "function") return chrome.scripting.executeScript(details);
        const { func, args = [], ...rest } = details;
        return chrome.scripting.executeScript({
          ...rest,
          world: rest.world || "MAIN",
          func: async (source, values) => {
            const argv = values || [];
            const args = argv;
            const runtime = { argv, args };
            const log = (...items) => console.log(...items);
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const done = (value = "") => {
              throw { __dietsurfDone: true, value };
            };
            const unavailable = (name) => async () => {
              throw new Error(`${name} is not available inside chrome.scripting.executeScript`);
            };
            const shell = unavailable("shell");
            const llm = unavailable("llm");
            const node = unavailable("node");
            const readFile = unavailable("readFile");
            const writeFile = unavailable("writeFile");
            const listFiles = unavailable("listFiles");
            const bindings = { argv, args, runtime, log, sleep, done, shell, llm, node, readFile, writeFile, listFiles };
            const prior = {};
            for (const [key, value] of Object.entries(bindings)) {
              prior[key] = { exists: key in globalThis, value: globalThis[key] };
              globalThis[key] = value;
            }
            try {
              return await (0, eval)(`(${source})`)(...argv);
            } catch (error) {
              if (error && error.__dietsurfDone) return error.value;
              throw error;
            } finally {
              for (const [key, state] of Object.entries(prior)) {
                if (state.exists) globalThis[key] = state.value;
                else delete globalThis[key];
              }
            }
          },
          args: [String(func), args]
        });
      }
    }
  };
}

let runtimePromise;
async function runtime() {
  await seedFiles();
  if (!runtimePromise) {
    runtimePromise = Promise.resolve(createRuntime({
      chrome: chromeFacade(),
      readFile,
      writeFile,
      listFiles,
      removeFile,
      log: (...args) => console.log(...args)
    }));
  }
  return runtimePromise;
}

async function appendHistory(record) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
  const prior = await readFile("/var/log/history.jsonl").catch(() => "");
  await writeFile("/var/log/history.jsonl", prior + line);
}

chrome.runtime.onInstalled.addListener(() => {
  seedFiles().catch((error) => console.error(error));
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    const rt = await runtime();
    if (message.type === "shell") {
      const result = await rt.shell(message.command);
      await appendHistory({ command: message.command, result });
      return { ok: true, result };
    }
    if (message.type === "readFile") return { ok: true, result: await readFile(message.path) };
    if (message.type === "writeFile") {
      await writeFile(message.path, message.text);
      return { ok: true, result: "" };
    }
    if (message.type === "listFiles") return { ok: true, result: await listFiles(message.path || "/") };
    throw new Error(`unknown message: ${message.type}`);
  })().then(
    (response) => sendResponse(response),
    (error) => sendResponse({ ok: false, error: toErrorText(error) })
  );
  return true;
});
