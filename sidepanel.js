import { loadModule, toErrorText } from "./kernel.js";

function send(message) {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (!response || !response.ok) throw new Error((response?.error || "worker error").split("\n")[0]);
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
  const style = document.createElement("style");
  style.textContent = await send({ type: "readFile", path: "/src/ui.css" }).catch(() => "");
  document.head.append(style);

  const uiRuntime = {
    document,
    readFile: (path) => send({ type: "readFile", path }),
    writeFile: (path, text) => send({ type: "writeFile", path, text }),
    listFiles: (path = "/") => send({ type: "listFiles", path }),
    shell: (command) => send({ type: "shell", command }),
    interrupt: () => undefined,
    log: () => undefined
  };

  const mod = await loadModule(uiRuntime, "/src/agent.js");
  if (!mod || typeof mod.render !== "function") throw new Error("/src/agent.js must export render(runtime)");
  await mod.render(uiRuntime);
}

main().catch((error) => fallback(toErrorText(error)));
