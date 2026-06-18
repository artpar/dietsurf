import Dexie from "dexie";
import { PROJECT_FILES, createRuntime, toErrorText } from "./kernel.js";

const STORE = "dietsurf.files";
const WORKSPACES = ["main", "staging"];
const db = new Dexie("dietsurf");
db.version(1).stores({ files: "path" });
const fileCache = new Map();
const activeRuns = new Map();
const runtimePromises = new Map();

function enableActionSidePanel() {
  if (!chrome.sidePanel?.setPanelBehavior) return;
  Promise.resolve(chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }))
    .catch((error) => console.error(error));
}

function formatLogArg(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  return JSON.stringify(value);
}

function logToPanel(workspace, ...args) {
  console.log(...args);
  chrome.runtime.sendMessage({ type: "workerLog", workspace, text: args.map(formatLogArg).join(" ") })
    .catch(() => undefined);
}

function notifyFileChanged(path) {
  chrome.runtime.sendMessage({ type: "fileChanged", path })
    .catch(() => undefined);
}

async function allFiles() {
  const rows = await db.files.toArray();
  return Object.fromEntries(rows.map((row) => [row.path, row.text]));
}

async function hydrateFileCache() {
  fileCache.clear();
  for (const row of await db.files.toArray()) fileCache.set(row.path, row.text);
}

async function readFile(path) {
  const file = await db.files.get(path);
  if (!file) throw new Error(`no such file: ${path}`);
  return file.text;
}

function readFileSync(path) {
  if (!fileCache.has(path)) throw new Error(`no such file: ${path}`);
  return fileCache.get(path);
}

async function writeFile(path, text) {
  const value = String(text);
  await db.files.put({ path, text: value });
  fileCache.set(path, value);
  notifyFileChanged(path);
}

async function listFiles(path = "/") {
  const files = await allFiles();
  const prefix = path === "/" ? "/" : `${path.replace(/\/$/, "")}/`;
  return Object.keys(files).filter((file) => file === path || file.startsWith(prefix));
}

async function removeFile(path) {
  await db.files.delete(path);
  fileCache.delete(path);
  notifyFileChanged(path);
}

async function migrateChromeStorage() {
  const data = await chrome.storage.local.get(STORE);
  const files = data[STORE] || {};
  const paths = Object.keys(files);
  if (!paths.length) return;
  await db.files.bulkPut(paths.map((path) => ({ path, text: String(files[path]) })));
  await chrome.storage.local.remove(STORE);
}

function workspacePath(workspace, path) {
  return `/${workspace}${path}`;
}

function workspaceText(workspace, path, text) {
  return String(text);
}

function workspaceOf(value) {
  return WORKSPACES.includes(value) ? value : "main";
}

async function packagedSourceFiles() {
  const files = [];
  for (const path of PROJECT_FILES) {
    const url = chrome.runtime.getURL(path.slice(1));
    const response = await fetch(url);
    files.push({ path, text: response.ok ? await response.text() : "" });
  }
  return files;
}

async function packagedFiles() {
  const files = [];
  for (const file of await packagedSourceFiles()) {
    for (const workspace of WORKSPACES) {
      files.push({
        path: workspacePath(workspace, file.path),
        text: workspaceText(workspace, file.path, file.text)
      });
    }
  }
  return files;
}

async function resetProject() {
  const files = await packagedFiles();
  await db.files.clear();
  await db.files.bulkPut(files);
  fileCache.clear();
  for (const file of files) fileCache.set(file.path, file.text);
  runtimePromises?.clear?.();
  notifyFileChanged("/");
}

async function seedMissingFiles() {
  const files = [];
  for (const file of await packagedFiles()) {
    if (await db.files.get(file.path)) continue;
    files.push(file);
  }
  if (files.length) await db.files.bulkPut(files);
  for (const file of files) fileCache.set(file.path, file.text);
}

async function removeLegacyRootFiles() {
  const paths = (await db.files.toArray())
    .map((row) => row.path)
    .filter((path) => !WORKSPACES.some((workspace) => path === `/${workspace}` || path.startsWith(`/${workspace}/`)));
  if (!paths.length) return;
  await db.files.bulkDelete(paths);
  for (const path of paths) fileCache.delete(path);
}

async function upgradeDefaultFile(workspace, sourcePath, shouldReplace) {
  const path = workspacePath(workspace, sourcePath);
  const current = await db.files.get(path);
  if (!current) return;
  if (!shouldReplace(current.text)) return;
  const response = await fetch(chrome.runtime.getURL(sourcePath.slice(1)));
  if (response.ok) await writeFile(path, workspaceText(workspace, sourcePath, await response.text()));
}

async function upgradeDefaultFiles() {
  for (const workspace of WORKSPACES) await upgradeWorkspaceDefaultFiles(workspace);
}

async function upgradeWorkspaceDefaultFiles(workspace) {
  await upgradeDefaultFile(workspace, "/etc/profile", (text) => (
    text.trim() === "# DietSurf profile"
  ) || (
    text.includes("DietSurf is a tiny shell over a virtual project.") &&
    !text.includes("Host package/build commands such as npm")
  ));
  await upgradeDefaultFile(workspace, "/manifest.json", (text) => (
    text.includes('"service_worker": "dist/worker.js"')
  ));
  await upgradeDefaultFile(workspace, "/sidepanel.html", (text) => (
    text.includes('src="dist/sidepanel.js"')
  ));
  await upgradeDefaultFile(workspace, "/package.json", (text) => (
    text.includes("--outdir=dist")
  ));
  await upgradeDefaultFile(workspace, "/kernel.js", (text) => (
    text.includes("./src/kernel/monetize.js")
  ));
  await upgradeDefaultFile(workspace, "/sidepanel.js", (text) => (
    text.includes("interrupt: () => undefined")
  ) || (
    text.includes('throw new Error((response?.error || "worker error").split("\\n")[0]);')
  ) || (
    !text.includes("/main/src/agent.js") ||
    !text.includes("/staging/src/agent.js")
  ));
  await upgradeDefaultFile(workspace, "/worker.js", (text) => (
    text.includes('"service_worker": "dist/worker.js"')
  ) || (
    text.includes('await upgradeDefaultFile("/etc/profile"') &&
    !text.includes('await upgradeDefaultFile("/sidepanel.html"')
  ));
  await upgradeDefaultFile(workspace, "/src/agent.js", (text) => (
    !text.includes("export async function main") ||
    !text.includes("export function render")
  ) || (
    text.includes('const WORKSPACE = "/main";')
  ) || (
    text.includes('const WORKSPACE = "/staging";')
  ) || (
    text.includes('input.placeholder = "node /src/agent.js \\"goal\\""') &&
    text.includes("const result = await shell(command);")
  ) || (
    text.includes('input.placeholder = "goal or shell command"') &&
    text.includes("const result = await shell(toShell(command));") &&
    !text.includes("dietsurf-status")
  ) || (
    text.includes("Available commands: cat, ls, pwd, cd, touch, rm, mkdir, cp, mv, echo, node, reset, jobs, kill.") &&
    text.includes('const shellCommands = new Set(["cat", "ls", "pwd", "cd", "touch", "rm", "mkdir", "cp", "mv", "echo", "node", "reset", "jobs", "kill"]);')
  ) || (
    text.includes("const clearScreen = () =>") &&
    !text.includes('await shell("clear")')
  ) || (
    text.includes("const history = []") &&
    text.includes("JSON.stringify(history)")
  ) || (
    text.includes("Return exactly one bash tool call per step.")
  ) || (
    text.includes("Available commands: cat, ls, pwd, cd, touch, rm, mkdir, cp, mv, echo, node, clear, reset, jobs, kill.") &&
    text.includes("If you can answer the user directly")
  ) || (
    text.includes("Available commands: cat, ls, pwd, cd, touch, rm, mkdir, cp, mv, echo, node, clear, reset, jobs, kill, which, grep, head, find.") &&
    !text.includes("/etc/browser.json and /src/runtime/chrome-puppeteer.js are only for running the same agent from real host Node")
  ) || (
    text.includes('input.placeholder = "goal or shell command"') &&
    text.includes('write("DietSurf")') &&
    !text.includes("interruptRun")
  ) || (
    text.includes('"You are helpful executive agent"')
  ) || (
    text.includes("Use cat > file <<'EOF' ... EOF to write files.")
  ) || (
    text.includes("Use fs.promises for Node-style file operations; it is backed by the virtual filesystem.")
  ));
  await upgradeDefaultFile(workspace, "/src/ui.css", (text) => (
    text.includes("#dietsurf-prompt:focus") &&
    !text.includes("#dietsurf-status")
  ) || (
    text.includes("grid-template-rows: 1fr auto auto") &&
    !text.includes("height: 100dvh")
  ) || (
    text.includes('#dietsurf-status[data-state="error"]') &&
    !text.includes('#dietsurf-status[data-state="aborted"]')
  ));
}

async function seedFiles() {
  await migrateChromeStorage();
  if (!(await db.files.get("/main/src/agent.js")) || !(await db.files.get("/staging/src/agent.js"))) {
    await resetProject();
    return;
  }
  await hydrateFileCache();
  await seedMissingFiles();
  await removeLegacyRootFiles();
  await upgradeDefaultFiles();
  await hydrateFileCache();
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

async function runtime(workspace) {
  await seedFiles();
  const key = workspaceOf(workspace);
  if (!runtimePromises.has(key)) {
    runtimePromises.set(key, Promise.resolve(createRuntime({
      workspace: key,
      llmConfigPath: `/${key}/etc/llm.json`,
      chrome: chromeFacade(),
      readFile,
      readFileSync,
      writeFile,
      listFiles,
      removeFile,
      resetProject,
      clearHistory: () => writeFile(`/${key}/var/log/history.jsonl`, ""),
      log: (...args) => logToPanel(key, ...args)
    })));
  }
  return runtimePromises.get(key);
}

async function appendHistory(workspace, record) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
  const path = `/${workspaceOf(workspace)}/var/log/history.jsonl`;
  const prior = await readFile(path).catch(() => "");
  await writeFile(path, prior + line);
}

chrome.runtime.onInstalled.addListener(() => {
  enableActionSidePanel();
  seedFiles().catch((error) => console.error(error));
});

enableActionSidePanel();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    const workspace = workspaceOf(message.workspace);
    if (message.type === "interrupt") {
      const activeRun = activeRuns.get(workspace);
      if (activeRun) {
        activeRun.controller.abort();
        return { ok: true, result: "aborting" };
      }
      return { ok: true, result: "idle" };
    }
    const rt = await runtime(workspace);
    if (message.type === "shell") {
      if (activeRuns.has(workspace)) throw new Error(`${workspace} shell is already running`);
      const controller = new AbortController();
      activeRuns.set(workspace, { controller });
      rt.abortSignal = controller.signal;
      try {
        const result = await rt.shell(message.command);
        if (!["clear", "reset"].includes(message.command.trim())) {
          await appendHistory(workspace, { command: message.command, result });
        }
        return { ok: true, result };
      } catch (error) {
        if (controller.signal.aborted) throw new Error("aborted");
        throw error;
      } finally {
        if (activeRuns.get(workspace)?.controller === controller) activeRuns.delete(workspace);
        if (rt.abortSignal === controller.signal) rt.abortSignal = undefined;
      }
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
