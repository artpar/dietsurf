import { loadModule, toErrorText } from "./kernel.js";

const logListeners = new Set();
let busy = 0;
let pendingReload = false;
let reloadTimer = 0;

function reloadsUi(path) {
  return path === "/" || path === "/src/agent.js" || path === "/src/ui.css";
}

function scheduleReload() {
  pendingReload = false;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => main().catch((error) => fallback(toErrorText(error))), 50);
}

function requestReload() {
  if (busy) {
    pendingReload = true;
    return;
  }
  scheduleReload();
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message) return false;
  if (message.type === "workerLog") {
    for (const listener of logListeners) listener(message.text);
  } else if (message.type === "fileChanged" && reloadsUi(message.path)) {
    requestReload();
  }
  return false;
});

function send(message) {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (!response || !response.ok) {
      const error = (response?.error || "worker error").split("\n")[0].replace(/^Error:\s*/, "");
      throw new Error(error);
    }
    return response.result;
  });
}

function fallback(message) {
  const app = document.getElementById("app");
  app.innerHTML = "";
  const pre = document.createElement("pre");
  pre.textContent = message;
  app.append(pre);
}

async function main() {
  logListeners.clear();

  let style = document.getElementById("dietsurf-style");
  if (!style) {
    style = document.createElement("style");
    style.id = "dietsurf-style";
    document.head.append(style);
  }
  style.textContent = await send({ type: "readFile", path: "/src/ui.css" }).catch(() => "");

  const run = async (fn) => {
    busy++;
    try {
      return await fn();
    } finally {
      busy--;
      if (!busy && pendingReload) scheduleReload();
    }
  };

  const uiRuntime = {
    document,
    readFile: (path) => send({ type: "readFile", path }),
    writeFile: (path, text) => run(() => send({ type: "writeFile", path, text })),
    listFiles: (path = "/") => send({ type: "listFiles", path }),
    shell: (command) => run(() => send({ type: "shell", command })),
    interrupt: () => send({ type: "interrupt" }),
    onLog(listener) {
      logListeners.add(listener);
      return () => logListeners.delete(listener);
    },
    log: () => undefined
  };

  const mod = await loadModule(uiRuntime, "/src/agent.js");
  if (!mod || typeof mod.render !== "function") throw new Error("/src/agent.js must export render(runtime)");
  await mod.render(uiRuntime);
}

main().catch((error) => fallback(toErrorText(error)));
