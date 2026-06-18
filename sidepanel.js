import { loadModule, toErrorText } from "./kernel.js";

const PANES = [
  { id: "main", title: "Main", agentPath: "/main/src/agent.js", stylePath: "/main/src/ui.css" },
  { id: "staging", title: "Staging", agentPath: "/staging/src/agent.js", stylePath: "/staging/src/ui.css" }
];

const states = new Map();

function stateFor(id) {
  if (!states.has(id)) {
    states.set(id, {
      busy: 0,
      pendingReload: false,
      reloadTimer: 0,
      logListeners: new Set()
    });
  }
  return states.get(id);
}

function paneForPath(path) {
  if (path === "/") return PANES.map((pane) => pane.id);
  return PANES
    .filter((pane) => path === pane.agentPath || path === pane.stylePath)
    .map((pane) => pane.id);
}

function send(message) {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (!response || !response.ok) {
      const error = (response?.error || "worker error").split("\n")[0].replace(/^Error:\s*/, "");
      throw new Error(error);
    }
    return response.result;
  });
}

function setFrameStyle() {
  let style = document.getElementById("dietsurf-frame-style");
  if (style) return;
  style = document.createElement("style");
  style.id = "dietsurf-frame-style";
  style.textContent = `
    :root {
      color-scheme: dark;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      background: #070707;
      color: #e5e5e5;
    }

    html,
    body,
    #app {
      height: 100%;
      margin: 0;
      overflow: hidden;
      background: #070707;
    }

    #dietsurf-split {
      display: grid;
      grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
      height: 100vh;
      height: 100dvh;
      min-height: 0;
      background: #070707;
    }

    .dietsurf-pane {
      display: grid;
      grid-template-rows: 25px minmax(0, 1fr);
      min-height: 0;
      border-top: 1px solid #242424;
      background: #080808;
    }

    .dietsurf-pane:first-child {
      border-top: 0;
    }

    .dietsurf-pane-header {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      padding: 0 10px;
      border-bottom: 1px solid #1b1b1b;
      background: #0d0d0d;
      color: #a8a8a8;
      font-size: 11px;
      line-height: 25px;
    }

    .dietsurf-pane-title {
      color: #e5e5e5;
      font-weight: 700;
    }

    .dietsurf-pane-path,
    .dietsurf-pane-state {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .dietsurf-pane-path {
      min-width: 0;
      color: #8b8b8b;
    }

    .dietsurf-pane-state {
      margin-left: auto;
      color: #8b8b8b;
    }

    .dietsurf-pane-state[data-state="running"] { color: #35f06b; }
    .dietsurf-pane-state[data-state="error"] { color: #ff6b5a; }
    .dietsurf-pane-state[data-state="aborted"] { color: #d0d0d0; }

    .dietsurf-pane-host {
      min-height: 0;
      overflow: hidden;
    }
  `;
  document.head.append(style);
}

function ensureFrame() {
  setFrameStyle();
  const app = document.getElementById("app");
  let split = document.getElementById("dietsurf-split");
  if (split) return split;

  app.innerHTML = "";
  split = document.createElement("div");
  split.id = "dietsurf-split";

  for (const pane of PANES) {
    const section = document.createElement("section");
    section.className = "dietsurf-pane";
    section.dataset.pane = pane.id;

    const header = document.createElement("div");
    header.className = "dietsurf-pane-header";

    const title = document.createElement("span");
    title.className = "dietsurf-pane-title";
    title.textContent = pane.title;

    const path = document.createElement("span");
    path.className = "dietsurf-pane-path";
    path.textContent = pane.agentPath;

    const state = document.createElement("span");
    state.className = "dietsurf-pane-state";
    state.dataset.state = "loading";
    state.textContent = "loading";

    const host = document.createElement("div");
    host.id = `dietsurf-${pane.id}-host`;
    host.className = "dietsurf-pane-host";

    header.append(title, path, state);
    section.append(header, host);
    split.append(section);
  }

  app.append(split);
  return split;
}

function paneStateElement(id) {
  return document.querySelector(`[data-pane="${id}"] .dietsurf-pane-state`);
}

function setPaneStatus(id, state, text) {
  const el = paneStateElement(id);
  if (!el) return;
  el.dataset.state = state;
  el.textContent = text;
}

function ensurePaneRoot(pane) {
  ensureFrame();
  const host = document.getElementById(`dietsurf-${pane.id}-host`);
  const shadow = host.shadowRoot || host.attachShadow({ mode: "open" });
  let app = shadow.getElementById("app");
  if (!app) {
    shadow.innerHTML = "";
    const base = document.createElement("style");
    base.id = "dietsurf-pane-base";
    base.textContent = `
      :host {
        display: block;
        height: 100%;
        min-height: 0;
        background: #080808;
      }

      #app {
        height: 100%;
        min-height: 0;
      }
    `;
    const style = document.createElement("style");
    style.id = "dietsurf-style";
    app = document.createElement("div");
    app.id = "app";
    shadow.append(base, style, app);
  }
  return { shadow, app, style: shadow.getElementById("dietsurf-style") };
}

function documentFor(shadow, app) {
  return new Proxy(document, {
    get(target, prop) {
      if (prop === "getElementById") {
        return (id) => id === "app" ? app : shadow.getElementById(id);
      }
      if (prop === "querySelector") {
        return (selector) => shadow.querySelector(selector) || target.querySelector(selector);
      }
      if (prop === "querySelectorAll") {
        return (selector) => {
          const local = [...shadow.querySelectorAll(selector)];
          return local.length ? local : target.querySelectorAll(selector);
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function schedulePaneReload(id) {
  const state = stateFor(id);
  state.pendingReload = false;
  clearTimeout(state.reloadTimer);
  const pane = PANES.find((item) => item.id === id);
  state.reloadTimer = setTimeout(() => {
    renderPane(pane).catch((error) => fallbackPane(pane, toErrorText(error)));
  }, 50);
}

async function runInPane(id, fn) {
  const state = stateFor(id);
  state.busy++;
  try {
    return await fn();
  } finally {
    state.busy--;
    if (!state.busy && state.pendingReload) schedulePaneReload(id);
  }
}

function requestPaneReload(id) {
  const state = stateFor(id);
  if (state.busy) {
    state.pendingReload = true;
    return;
  }
  schedulePaneReload(id);
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message) return false;
  if (message.type === "workerLog") {
    const targets = message.workspace ? [message.workspace] : PANES.map((pane) => pane.id);
    for (const id of targets) {
      for (const listener of stateFor(id).logListeners) listener(message.text);
    }
  } else if (message.type === "fileChanged") {
    for (const id of paneForPath(message.path)) requestPaneReload(id);
  }
  return false;
});

function complete(script) {
  const lines = script.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/<<\s*['"]?([A-Za-z0-9_.-]+)['"]?(?:\s|$)/);
    if (match && !lines.slice(i + 1).some((line) => line === match[1])) return false;
  }
  return true;
}

function rescueStyle() {
  return `
    #dietsurf-rescue {
      display: grid;
      grid-template-rows: minmax(0, 1fr) auto auto;
      height: 100%;
      min-height: 0;
      background: #080808;
      color: #e5e5e5;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }

    #dietsurf-log {
      box-sizing: border-box;
      min-height: 0;
      margin: 0;
      padding: 10px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      line-height: 1.45;
    }

    #dietsurf-status {
      box-sizing: border-box;
      min-height: 24px;
      border-top: 1px solid #1f1f1f;
      padding: 4px 10px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      background: #0c0c0c;
      color: #9a9a9a;
      font-size: 11px;
      line-height: 16px;
    }

    #dietsurf-status[data-state="running"] { color: #35f06b; }
    #dietsurf-status[data-state="error"] { color: #ff6b5a; }
    #dietsurf-status[data-state="aborted"] { color: #d0d0d0; }

    #dietsurf-prompt {
      box-sizing: border-box;
      width: 100%;
      min-height: 38px;
      max-height: 180px;
      border: 0;
      border-top: 1px solid #2a2a2a;
      padding: 10px;
      outline: none;
      resize: none;
      background: #101010;
      color: #e5e5e5;
      caret-color: #35f06b;
      font: inherit;
      line-height: 1.45;
    }

    #dietsurf-prompt:focus { border-top-color: #35f06b; }
  `;
}

function fallbackPane(pane, message) {
  const state = stateFor(pane.id);
  state.logListeners.clear();
  setPaneStatus(pane.id, "error", "rescue");

  const { shadow, app, style } = ensurePaneRoot(pane);
  style.textContent = rescueStyle();
  app.innerHTML = "";

  const root = document.createElement("div");
  root.id = "dietsurf-rescue";

  const output = document.createElement("pre");
  output.id = "dietsurf-log";

  const status = document.createElement("div");
  status.id = "dietsurf-status";
  status.textContent = "rescue";

  const input = document.createElement("textarea");
  input.id = "dietsurf-prompt";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.rows = 1;
  input.placeholder = `rescue shell: cat ${pane.agentPath}, reset`;

  root.append(output, status, input);
  app.append(root);

  let running = false;
  let interrupting = false;

  const write = (value = "") => {
    output.textContent += String(value) + "\n";
    output.scrollTop = output.scrollHeight;
  };

  const setStatus = (stateName, text) => {
    status.dataset.state = stateName;
    status.textContent = text;
    setPaneStatus(pane.id, stateName, text);
  };

  const interruptRun = async () => {
    if (!running || interrupting) return;
    interrupting = true;
    write("^C");
    setStatus("running", "interrupting");
    try {
      await send({ type: "interrupt", workspace: pane.id });
    } catch (error) {
      write(error && error.message ? error.message : String(error));
    }
  };

  state.logListeners.add((text) => {
    if (running) write(text);
  });

  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = input.scrollHeight + "px";
  });

  input.addEventListener("keydown", async (event) => {
    if (running && (event.key === "Escape" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c"))) {
      event.preventDefault();
      await interruptRun();
      return;
    }
    if (event.key !== "Enter") return;
    if (event.shiftKey || !complete(input.value)) return;
    event.preventDefault();
    const command = input.value.trim();
    if (!command) return;
    if (running) {
      if (["kill", "cancel", "abort", "^c"].includes(command.toLowerCase())) {
        input.value = "";
        input.style.height = "auto";
        await interruptRun();
      }
      return;
    }
    input.value = "";
    input.style.height = "auto";
    write("$ " + command);
    running = true;
    setStatus("running", command.replace(/\s+/g, " ").slice(0, 96));
    try {
      const result = await runInPane(pane.id, () => send({ type: "shell", workspace: pane.id, command }));
      if (result) write(result);
      if (command === "reset") {
        setStatus("running", "reloading");
        for (const item of PANES) schedulePaneReload(item.id);
      } else {
        setStatus("done", "done");
      }
    } catch (error) {
      const text = error && error.message ? error.message : String(error);
      if (text === "aborted" || text === "Error: aborted") setStatus("aborted", "aborted");
      else {
        setStatus("error", "error");
        write(text);
      }
    } finally {
      running = false;
      interrupting = false;
    }
  });

  write(`${pane.title} rescue`);
  write(message);
  write("");
  write(`Use \`cat ${pane.agentPath}\` to inspect, \`cat > ${pane.agentPath} <<'EOF'\` to repair, or \`reset\` to restore packaged defaults.`);
  input.focus();
}

async function renderPane(pane) {
  const state = stateFor(pane.id);
  state.logListeners.clear();
  setPaneStatus(pane.id, "loading", "loading");

  const { shadow, app, style } = ensurePaneRoot(pane);
  style.textContent = await send({ type: "readFile", path: pane.stylePath }).catch(() => "");

  const paneDocument = documentFor(shadow, app);
  const uiRuntime = {
    workspace: pane.id,
    agentPath: pane.agentPath,
    stylePath: pane.stylePath,
    document: paneDocument,
    mount: app,
    window,
    localStorage: window.localStorage,
    matchMedia: window.matchMedia.bind(window),
    readFile: (path) => send({ type: "readFile", path }),
    writeFile: (path, text) => runInPane(pane.id, () => send({ type: "writeFile", path, text })),
    listFiles: (path = "/") => send({ type: "listFiles", path }),
    shell: (command) => runInPane(pane.id, () => send({ type: "shell", workspace: pane.id, command })),
    interrupt: () => send({ type: "interrupt", workspace: pane.id }),
    onLog(listener) {
      state.logListeners.add(listener);
      return () => state.logListeners.delete(listener);
    },
    log: () => undefined
  };

  const mod = await loadModule(uiRuntime, pane.agentPath);
  if (!mod || typeof mod.render !== "function") throw new Error(`${pane.agentPath} must export render(runtime)`);
  await mod.render(uiRuntime);
  setPaneStatus(pane.id, "ready", "ready");
}

async function main() {
  ensureFrame();
  await Promise.all(PANES.map((pane) => (
    renderPane(pane).catch((error) => fallbackPane(pane, toErrorText(error)))
  )));
}

main().catch((error) => {
  const app = document.getElementById("app");
  app.innerHTML = "";
  const pre = document.createElement("pre");
  pre.textContent = toErrorText(error);
  app.append(pre);
});
