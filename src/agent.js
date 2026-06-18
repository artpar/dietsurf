export async function main(runtime, argv) {
  const { shell, query, log } = runtime;
  const goal = argv.join(" ").trim();
  if (!goal) {
    log("usage: node /src/agent.js \"goal\"");
    return "";
  }

  const system = [
    "You are running inside DietSurf, a tiny Mini-SWE-style browser agent.",
    "You have one optional tool: bash.",
    "The bash tool runs one command in a tiny bash-like shell.",
    "Available commands: cat, ls, pwd, cd, touch, rm, mkdir, cp, mv, echo, node, clear, reset, jobs, kill, which, grep, head, find, env, printenv, uname.",
    "Pipes, && sequencing, || fallback, simple > redirects, 2>/dev/null, $ENV expansion, and file globs like /src/*.js are supported.",
    "Use bash only when you need to inspect or change files, run JavaScript, or interact with the browser.",
    "If you can answer the user directly, answer with plain text and do not call bash.",
    "Separate command names from arguments with spaces, like echo \"answer\", never echo\"answer\".",
    "Use cat > file <<'EOF' ... EOF to write files.",
    "Use node -e \"code\" or node <<'EOF' ... EOF to run JavaScript.",
    "Inside node, globals include process, Buffer, fs, path, crypto, require, chrome, shell, llm, readFile, writeFile, listFiles, log, and done.",
    "Use fs.promises for Node-style file operations; it is backed by the virtual filesystem.",
    "For browser page work in the extension, use chrome.tabs.query and chrome.scripting.executeScript directly.",
    "/etc/browser.json and /src/runtime/chrome-puppeteer.js are only for running the same agent from real host Node; do not inspect local Chrome binaries for extension browser tasks.",
    "When done, run node <<'EOF'\ndone(\"answer\")\nEOF.",
    "If you use bash, call it at most once per step."
  ].join("\n");

  const tree = await shell("ls -R /");
  const messages = [
    { role: "system", content: system },
    { role: "user", content: "Goal:\n" + goal + "\n\nInitial project tree:\n" + tree }
  ];

  const commandFrom = (response) => {
    const call = (response.toolCalls || []).find((item) => item.toolName === "bash");
    if (call) return { call, command: String(call.input?.command || "").trim() };
    return { call: null, command: String(response.text || "").trim() };
  };

  const appendAssistant = (response, command, call) => {
    if (call) {
      messages.push({
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId: call.toolCallId,
          toolName: "bash",
          input: { command }
        }]
      });
    } else if (response.messages?.length) {
      messages.push(...response.messages);
    } else {
      messages.push({ role: "assistant", content: command });
    }
  };

  const appendObservation = (call, observation) => {
    if (call) {
      messages.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: "bash",
          output: { type: "json", value: observation }
        }]
      });
    } else {
      messages.push({ role: "user", content: "Observation:\n" + JSON.stringify(observation) });
    }
  };

  for (let step = 0; step < 20; step++) {
    const response = await query(messages, { tool: "bash" });
    const { call, command } = commandFrom(response);
    appendAssistant(response, command, call);
    if (!call) {
      if (!command) throw new Error("model returned no response");
      return command;
    }
    if (!command) throw new Error("model returned empty bash command");

    log("$ " + command);
    try {
      const result = await shell(command);
      if (result) log(result);
      appendObservation(call, { returncode: 0, output: result || "" });
    } catch (error) {
      if (error && error.__dietsurfDone) {
        return error.value ?? "";
      }
      const output = error && error.message ? error.message : String(error);
      log(output);
      appendObservation(call, { returncode: 1, output });
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
  let interrupting = false;
  let statusTimer;

  const write = (value = "") => {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    output.textContent += text + "\n";
    output.scrollTop = output.scrollHeight;
    log(text);
  };

  const alreadyShown = (value) => {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return output.textContent.trimEnd().endsWith(text.trimEnd());
  };

  runtime.onLog?.((text) => {
    if (!running) return;
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

  const interruptRun = async () => {
    if (!running || interrupting) return;
    interrupting = true;
    write("^C");
    setStatus("running", "interrupting");
    try {
      await runtime.interrupt?.();
    } catch (error) {
      write(error && error.message ? error.message : String(error));
    }
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

  const shellCommands = new Set(["cat", "ls", "pwd", "cd", "touch", "rm", "mkdir", "cp", "mv", "echo", "node", "clear", "reset", "jobs", "kill", "which", "grep", "head", "find", "env", "printenv", "uname"]);
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
    startStatus(script);
    try {
      const result = await shell(script);
      if (result && !alreadyShown(result)) write(result);
      stopStatus("done");
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      if (message === "aborted" || message === "Error: aborted") stopStatus("aborted");
      else {
        stopStatus("error");
        write(message);
      }
    } finally {
      running = false;
      interrupting = false;
    }
  });

  write("DietSurf");
  write("ls -R /");
}

export default { main, render };
