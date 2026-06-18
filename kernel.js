import { generateText, jsonSchema, tool } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { Buffer } from "buffer";
import { createEnvironment, execute } from "jslike";
import pathShim from "path-browserify";
import processShim from "process/browser.js";
import { split } from "shlex";

export const PROJECT_FILES = [
  "/package.json",
  "/manifest.json",
  "/bin/dietsurf-node.js",
  "/etc/llm.json",
  "/etc/browser.json",
  "/etc/profile",
  "/src/agent.js",
  "/src/runtime/chrome-puppeteer.js",
  "/src/ui.css",
  "/var/log/history.jsonl",
  "/home/user/notes.md"
];

export function toErrorText(error) {
  return error && error.stack ? error.stack : String(error);
}

export function absPath(path, cwd = "/") {
  if (!path || path === ".") return cwd || "/";
  const raw = path.startsWith("/") ? path : `${cwd.replace(/\/$/, "")}/${path}`;
  const parts = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function dirOf(path) {
  const clean = absPath(path);
  const idx = clean.lastIndexOf("/");
  return idx <= 0 ? "/" : clean.slice(0, idx);
}

function makeEnv(runtime) {
  const env = createEnvironment();
  const module = { exports: {} };
  const globals = {
    runtime,
    argv: runtime.argv || [],
    process: runtime.process,
    Buffer: runtime.Buffer,
    chrome: runtime.chrome,
    llm: runtime.llm,
    shell: runtime.shell,
    node: runtime.node,
    fs: runtime.fs,
    path: runtime.path,
    crypto: runtime.crypto,
    require: runtime.require,
    module,
    exports: module.exports,
    global: runtime.global,
    globalThis: runtime.global,
    readFile: runtime.readFile,
    writeFile: runtime.writeFile,
    listFiles: runtime.listFiles,
    env: runtime.env,
    console: runtime.console,
    fetch: runtime.fetch,
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    sleep: runtime.sleep,
    log: runtime.log,
    done: runtime.done
  };
  for (const [key, value] of Object.entries(globals)) {
    if (value !== undefined) env.define(key, value);
  }
  return env;
}

function builtinModuleSource(modulePath) {
  const name = modulePath.replace(/^node:/, "");
  if (name === "fs") {
    return [
      'const fs = require("fs")',
      "export default fs",
      "export const promises = fs.promises",
      "export const readFile = fs.readFile",
      "export const writeFile = fs.writeFile",
      "export const readdir = fs.readdir",
      "export const rm = fs.rm",
      "export const unlink = fs.unlink",
      "export const mkdir = fs.mkdir",
      "export const stat = fs.stat",
      "export const access = fs.access",
      "export const rename = fs.rename",
      "export const cp = fs.cp"
    ].join("\n");
  }
  if (name === "fs/promises") {
    return [
      'const fs = require("fs/promises")',
      "export default fs",
      "export const readFile = fs.readFile",
      "export const writeFile = fs.writeFile",
      "export const readdir = fs.readdir",
      "export const rm = fs.rm",
      "export const unlink = fs.unlink",
      "export const mkdir = fs.mkdir",
      "export const stat = fs.stat",
      "export const access = fs.access",
      "export const rename = fs.rename",
      "export const cp = fs.cp"
    ].join("\n");
  }
  if (name === "path") {
    return [
      'const path = require("path")',
      "export default path",
      "export const join = path.join",
      "export const resolve = path.resolve",
      "export const dirname = path.dirname",
      "export const basename = path.basename",
      "export const extname = path.extname",
      "export const normalize = path.normalize"
    ].join("\n");
  }
  if (name === "buffer") return 'const buffer = require("buffer")\nexport default buffer\nexport const Buffer = buffer.Buffer';
  if (name === "process") return 'const process = require("process")\nexport default process';
  if (name === "crypto") return 'const crypto = require("crypto")\nexport default crypto';
  return "";
}

function resolverFor(runtime) {
  return {
    async resolve(modulePath, fromPath = "/src/agent.js") {
      const builtin = builtinModuleSource(modulePath);
      if (builtin) return { path: modulePath, code: builtin };
      if (!modulePath.startsWith(".") && !modulePath.startsWith("/")) return null;
      const base = modulePath.startsWith("/") ? "/" : dirOf(fromPath);
      let path = absPath(modulePath, base);
      if (!/\.[cm]?[jt]sx?$/.test(path)) path += ".js";
      return { path, code: await runtime.readFile(path) };
    }
  };
}

export async function runSource(runtime, source, sourcePath = "/tmp/stdin.js") {
  return execute(source, makeEnv(runtime), {
    sourcePath,
    moduleResolver: resolverFor(runtime)
  });
}

export async function loadModule(runtime, path) {
  const source = await runtime.readFile(path);
  return runSource(runtime, source, path);
}

export async function runFile(runtime, path, argv = []) {
  const nextRuntime = { ...runtime, argv };
  const mod = await loadModule(nextRuntime, path);
  if (mod && typeof mod.main === "function") return mod.main(nextRuntime, argv);
  return mod;
}

function isDone(error) {
  return error && error.__dietsurfDone;
}

function heredoc(lines, start) {
  const line = lines[start];
  const match = line.match(/^(.*?)<<['"]?([A-Za-z0-9_.-]+)['"]?\s*$/);
  if (!match) return null;
  const body = [];
  let i = start + 1;
  for (; i < lines.length; i++) {
    if (lines[i] === match[2]) break;
    body.push(lines[i]);
  }
  if (i >= lines.length) throw new Error(`unterminated heredoc ${match[2]}`);
  return { head: match[1].trim(), body: body.join("\n"), next: i + 1 };
}

function formatLs(paths, dir, recursive) {
  const prefix = dir === "/" ? "/" : `${dir.replace(/\/$/, "")}/`;
  const out = new Set();
  for (const path of paths.sort()) {
    if (path === dir) continue;
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (!rest) continue;
    if (recursive) out.add(path);
    else out.add(rest.split("/")[0] + (rest.includes("/") ? "/" : ""));
  }
  return [...out].join("\n");
}

function encodingOf(options) {
  if (typeof options === "string") return options;
  if (options && typeof options === "object") return options.encoding;
  return "";
}

function textOf(value, encoding = "utf8") {
  if (Buffer.isBuffer(value)) return value.toString(encoding);
  if (value instanceof Uint8Array) return Buffer.from(value).toString(encoding);
  return String(value);
}

function fileStat(path, text, directory) {
  return {
    path,
    size: directory ? 0 : Buffer.byteLength(text || ""),
    isFile: () => !directory,
    isDirectory: () => directory,
    isSymbolicLink: () => false
  };
}

function createFs(runtime) {
  const filePath = (path) => absPath(String(path), runtime.cwd || "/");
  const promises = {
    async readFile(path, options) {
      const text = await runtime.readFile(filePath(path));
      return encodingOf(options) ? text : Buffer.from(text);
    },
    async writeFile(path, data, options) {
      await runtime.writeFile(filePath(path), textOf(data, encodingOf(options) || "utf8"));
    },
    async readdir(path = ".") {
      const dir = filePath(path);
      const prefix = dir === "/" ? "/" : `${dir.replace(/\/$/, "")}/`;
      const out = new Set();
      for (const file of await runtime.listFiles(dir)) {
        if (file === dir) continue;
        const rest = file.startsWith(prefix) ? file.slice(prefix.length) : "";
        if (rest) out.add(rest.split("/")[0]);
      }
      return [...out].sort();
    },
    async rm(path) {
      await runtime.removeFile(filePath(path));
    },
    async unlink(path) {
      await runtime.removeFile(filePath(path));
    },
    async mkdir() {},
    async stat(path) {
      const target = filePath(path);
      try {
        return fileStat(target, await runtime.readFile(target), false);
      } catch (error) {
        const children = await runtime.listFiles(target);
        if (children.some((file) => file !== target)) return fileStat(target, "", true);
        throw error;
      }
    },
    async access(path) {
      await promises.stat(path);
    },
    async rename(from, to) {
      const source = filePath(from);
      const target = filePath(to);
      await runtime.writeFile(target, await runtime.readFile(source));
      await runtime.removeFile(source);
    },
    async cp(from, to) {
      await runtime.writeFile(filePath(to), await runtime.readFile(filePath(from)));
    }
  };
  const callback = (fn) => (...args) => {
    const cb = typeof args[args.length - 1] === "function" ? args.pop() : undefined;
    const promise = fn(...args);
    if (cb) promise.then((value) => cb(null, value), cb);
    return promise;
  };
  return {
    promises,
    readFile: callback(promises.readFile),
    writeFile: callback(promises.writeFile),
    readdir: callback(promises.readdir),
    rm: callback(promises.rm),
    unlink: callback(promises.unlink),
    mkdir: callback(promises.mkdir),
    stat: callback(promises.stat),
    access: callback(promises.access),
    rename: callback(promises.rename),
    cp: callback(promises.cp)
  };
}

function createProcess(runtime, base) {
  return {
    ...processShim,
    ...base.process,
    env: runtime.env,
    argv: runtime.argv,
    browser: !globalThis.process?.versions?.node,
    versions: { ...(processShim.versions || {}), ...(globalThis.process?.versions || {}) },
    platform: globalThis.process?.platform || "browser",
    cwd: () => runtime.cwd || "/",
    nextTick: processShim.nextTick || ((fn, ...args) => Promise.resolve().then(() => fn(...args)))
  };
}

function createRequire(runtime) {
  return function require(name) {
    const key = String(name).replace(/^node:/, "");
    if (key in runtime.modules) return runtime.modules[key];
    throw new Error(`cannot find module: ${name}`);
  };
}

export function createShell(runtime) {
  let cwd = "/";

  async function execArgv(argv) {
    const cmd = argv[0];
    if (!cmd) return "";
    if (cmd === "pwd") return cwd;
    if (cmd === "cd") {
      cwd = absPath(argv[1] || "/", cwd);
      return "";
    }
    if (cmd === "cat") return runtime.readFile(absPath(argv[1], cwd));
    if (cmd === "ls") {
      const recursive = argv.includes("-R");
      const target = argv.find((arg, i) => i > 0 && arg !== "-R") || ".";
      return formatLs(await runtime.listFiles(absPath(target, cwd)), absPath(target, cwd), recursive);
    }
    if (cmd === "touch") {
      await runtime.writeFile(absPath(argv[1], cwd), "");
      return "";
    }
    if (cmd === "rm") {
      await runtime.removeFile(absPath(argv[1], cwd));
      return "";
    }
    if (cmd === "mkdir") return "";
    if (cmd === "cp") {
      await runtime.writeFile(absPath(argv[2], cwd), await runtime.readFile(absPath(argv[1], cwd)));
      return "";
    }
    if (cmd === "mv") {
      const from = absPath(argv[1], cwd);
      const to = absPath(argv[2], cwd);
      await runtime.writeFile(to, await runtime.readFile(from));
      await runtime.removeFile(from);
      return "";
    }
    if (cmd === "echo") return argv.slice(1).join(" ");
    if (cmd === "node") return runFile(runtime, absPath(argv[1], cwd), argv.slice(2));
    if (cmd === "clear") {
      await runtime.clearHistory?.();
      return "";
    }
    if (cmd === "reset") {
      if (!runtime.resetProject) throw new Error("reset is not available");
      await runtime.resetProject();
      return "reset virtual project";
    }
    if (cmd === "jobs") return "";
    if (cmd === "kill") return "";
    throw new Error(`unknown command: ${cmd}`);
  }

  return async function shell(script) {
    const lines = String(script).replace(/\r\n/g, "\n").split("\n");
    const output = [];
    for (let i = 0; i < lines.length;) {
      const line = lines[i].trim();
      if (!line || line.startsWith("#")) {
        i++;
        continue;
      }
      const doc = heredoc(lines, i);
      if (doc) {
        const argv = split(doc.head);
        if (argv[0] === "cat" && (argv[1] === ">" || argv[1] === ">>")) {
          const path = absPath(argv[2], cwd);
          const prior = argv[1] === ">>" ? await runtime.readFile(path).catch(() => "") : "";
          await runtime.writeFile(path, prior + doc.body);
        } else if (argv[0] === "node") {
          const result = await runSource(runtime, doc.body, "/tmp/stdin.js");
          if (result !== undefined) output.push(String(result));
        } else {
          throw new Error(`unsupported heredoc command: ${doc.head}`);
        }
        i = doc.next;
        continue;
      }
      const result = await execArgv(split(line));
      if (result !== undefined && result !== "") output.push(String(result));
      i++;
    }
    return output.join("\n");
  };
}

export function createRuntime(base) {
  const runtime = {
    argv: [],
    cwd: "/",
    chrome: base.chrome,
    readFile: base.readFile,
    writeFile: base.writeFile,
    listFiles: base.listFiles,
    removeFile: base.removeFile,
    resetProject: base.resetProject,
    clearHistory: base.clearHistory,
    env: base.env || {},
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: base.log || console.log
  };
  runtime.console = base.console || {
    log: (...args) => runtime.log(...args),
    warn: (...args) => runtime.log(...args),
    error: (...args) => runtime.log(...args)
  };
  runtime.fetch = base.fetch || (globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined);
  runtime.Buffer = Buffer;
  runtime.path = pathShim.posix || pathShim;
  runtime.crypto = base.crypto || globalThis.crypto;
  runtime.fs = createFs(runtime);
  runtime.process = createProcess(runtime, base);
  runtime.modules = {
    fs: runtime.fs,
    "fs/promises": runtime.fs.promises,
    path: runtime.path,
    buffer: { Buffer },
    process: runtime.process,
    crypto: runtime.crypto
  };
  runtime.require = createRequire(runtime);
  runtime.global = {
    runtime,
    argv: runtime.argv,
    process: runtime.process,
    Buffer,
    fs: runtime.fs,
    path: runtime.path,
    crypto: runtime.crypto,
    require: runtime.require
  };
  async function query(input, options = {}) {
    const { baseUrl, apiKey, apiKeyEnv, model } = JSON.parse(await runtime.readFile("/etc/llm.json"));
    const key = apiKey || runtime.env[apiKeyEnv];
    if (!key) throw new Error(`missing /etc/llm.json apiKey${apiKeyEnv ? ` or ${apiKeyEnv}` : ""}`);
    const provider = createOpenAICompatible({ name: "byok", apiKey: key, baseURL: baseUrl });
    const messages = Array.isArray(input) ? input : [{ role: "user", content: String(input) }];
    const request = { model: provider(model), messages, temperature: 0, allowSystemInMessages: true };
    if (options.tool === "bash") {
      request.tools = {
        bash: tool({
          description: "Run one command in the DietSurf bash-like shell.",
          inputSchema: jsonSchema({
            type: "object",
            properties: {
              command: {
                type: "string",
                description: "The shell command to execute."
              }
            },
            required: ["command"],
            additionalProperties: false
          })
        })
      };
    }
    const result = await generateText(request);
    return {
      text: result.text.trim(),
      toolCalls: result.toolCalls,
      messages: result.response.messages,
      finishReason: result.finishReason
    };
  }
  runtime.query = query;
  runtime.llm = async function llm(input) {
    return (await query(input)).text;
  };
  runtime.done = (value = "") => {
    const error = new Error("done");
    error.__dietsurfDone = true;
    error.value = value;
    throw error;
  };
  runtime.node = (code, argv = []) => runSource({ ...runtime, argv }, code, "/tmp/stdin.js");
  runtime.shell = createShell(runtime);
  runtime.runFile = async (path, argv = []) => {
    try {
      return await runFile({ ...runtime, argv }, path, argv);
    } catch (error) {
      if (isDone(error)) return error.value;
      throw error;
    }
  };
  return runtime;
}
