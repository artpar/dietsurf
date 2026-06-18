export async function main(runtime, argv) {
  const { shell, llm, log } = runtime;
  const goal = argv.join(" ").trim();
  if (!goal) {
    log("usage: node /src/agent.js \"goal\"");
    return "";
  }

  const history = [];
  for (let step = 0; step < 20; step++) {
    const tree = await shell("ls -R /");
    const command = await llm(
      "You are running inside a tiny bash-like shell.\n" +
      "Available commands: cat, ls, pwd, cd, touch, rm, mkdir, cp, mv, echo, node, clear, reset, jobs, kill.\n" +
      "Separate command names from arguments with spaces, like echo \"answer\", never echo\"answer\".\n" +
      "Use cat > file <<'EOF' ... EOF to write files.\n" +
      "Use node <<'EOF' ... EOF to run JavaScript.\n" +
      "Inside node, globals include process, Buffer, fs, path, crypto, require, chrome, shell, llm, readFile, writeFile, listFiles, log, and done.\n" +
      "Use fs.promises for Node-style file operations; it is backed by the virtual filesystem.\n" +
      "For browser page work, use chrome.tabs.query and chrome.scripting.executeScript.\n" +
      "When done, run node <<'EOF'\\ndone(\"answer\")\\nEOF.\n\n" +
      "Return raw shell only. Do not use markdown fences, backticks, prose, or explanations.\n\n" +
      "Example for reading the active tab title:\n" +
      "node <<'EOF'\n" +
      "const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })\n" +
      "const result = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.title })\n" +
      "done(result[0].result)\n" +
      "EOF\n\n" +
      "Project tree:\n" + tree + "\n\n" +
      "Goal: " + goal + "\n\n" +
      "History:\n" + JSON.stringify(history)
    );

    log("$ " + command);
    try {
      const result = await shell(command);
      if (result) log(result);
      history.push({ command, result });
    } catch (error) {
      if (error && error.__dietsurfDone) {
        log(String(error.value ?? ""));
        return error.value ?? "";
      }
      throw error;
    }
  }
  return "";
}

export function render(runtime) {
  const { document, shell, log } = runtime;
  const app = document.getElementById("app");
  app.innerHTML = "";

  const root = document.createElement("div");
  root.id = "dietsurf";

  const output = document.createElement("pre");
  output.id = "dietsurf-log";

  const status = document.createElement("div");
  status.id = "dietsurf-status";
  status.textContent = "idle";

  const input = document.createElement("textarea");
  input.id = "dietsurf-prompt";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.rows = 1;
  input.placeholder = "goal or shell command";

  root.append(output, status, input);
  app.append(root);

  let running = false;
  let workerLogged = false;
  let statusTimer;

  const write = (value = "") => {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    output.textContent += text + "\n";
    output.scrollTop = output.scrollHeight;
    log(text);
  };

  runtime.onLog?.((text) => {
    if (!running) return;
    workerLogged = true;
    write(text);
  });

  const setStatus = (state, text) => {
    status.dataset.state = state;
    status.textContent = text;
  };

  const startStatus = (script) => {
    const started = Date.now();
    const label = script.replace(/\s+/g, " ").slice(0, 96);
    clearInterval(statusTimer);
    const tick = () => setStatus("running", `running ${Math.floor((Date.now() - started) / 1000)}s  ${label}`);
    tick();
    statusTimer = setInterval(tick, 1000);
  };

  const stopStatus = (state) => {
    clearInterval(statusTimer);
    setStatus(state, state);
  };

  const complete = (script) => {
    const lines = script.replace(/\r\n/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/<<['"]?([A-Za-z0-9_.-]+)['"]?\s*$/);
      if (match && !lines.slice(i + 1).some((line) => line === match[1])) return false;
    }
    return true;
  };

  const clearScreen = () => {
    output.textContent = "";
    stopStatus("idle");
  };

  const shellCommands = new Set(["cat", "ls", "pwd", "cd", "touch", "rm", "mkdir", "cp", "mv", "echo", "node", "clear", "reset", "jobs", "kill"]);
  const toShell = (value) => {
    const first = value.trim().split(/\s+/, 1)[0];
    if (value.includes("\n") || shellCommands.has(first)) return value;
    return "node /src/agent.js " + JSON.stringify(value);
  };

  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = input.scrollHeight + "px";
  });

  input.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") return;
    if (event.shiftKey || !complete(input.value)) return;
    event.preventDefault();
    const command = input.value.trim();
    if (!command) return;
    input.value = "";
    input.style.height = "auto";
    if (command === "clear") {
      try {
        await shell("clear");
        clearScreen();
      } catch (error) {
        clearScreen();
        write(error && error.message ? error.message : String(error));
      }
      return;
    }
    write("$ " + command);
    const script = toShell(command);
    running = true;
    workerLogged = false;
    startStatus(script);
    try {
      const result = await shell(script);
      if (result && !workerLogged) write(result);
      stopStatus("done");
    } catch (error) {
      stopStatus("error");
      write(error && error.message ? error.message : String(error));
    } finally {
      running = false;
    }
  });

  write("DietSurf");
  write("ls -R /");
}

export default { main, render };
