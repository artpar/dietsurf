export const PROJECT_FILES = [
  "/package.json",
  "/manifest.json",
  "/kernel.js",
  "/worker.js",
  "/sidepanel.js",
  "/sidepanel.html",
  "/bin/dietsurf-node.js",
  "/etc/llm.json",
  "/etc/browser.json",
  "/etc/profile",
  "/src/agent.js",
  "/src/runtime/chrome-puppeteer.js",
  "/src/kernel/project.js",
  "/src/kernel/path.js",
  "/src/kernel/jslike.js",
  "/src/kernel/fs.js",
  "/src/kernel/shell.js",
  "/src/kernel/runtime.js",
  "/src/ui.css",
  "/var/log/history.jsonl",
  "/home/user/notes.md"
];

export function toErrorText(error) {
  return error && error.stack ? error.stack : String(error);
}
