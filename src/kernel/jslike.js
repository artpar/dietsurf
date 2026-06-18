import { Buffer } from "buffer";
import { createEnvironment, execute } from "jslike";
import { absPath, dirOf } from "./path.js";

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
    document: runtime.document,
    window: runtime.window,
    localStorage: runtime.localStorage,
    matchMedia: runtime.matchMedia,
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
  const nextRuntime = { ...runtime, argv, agentPath: path, entryPath: path };
  const mod = await loadModule(nextRuntime, path);
  if (mod && typeof mod.main === "function") return mod.main(nextRuntime, argv);
  return mod;
}

export { Buffer };
