import { generateText, jsonSchema, tool } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { Buffer } from "buffer";
import pathShim from "path-browserify";
import processShim from "process/browser.js";
import { createFs } from "./fs.js";
import { createShell } from "./shell.js";
import { runFile, runSource } from "./jslike.js";

function isDone(error) {
  return error && error.__dietsurfDone;
}

function createProcess(runtime, base) {
  return {
    ...processShim,
    ...base.process,
    env: runtime.env,
    argv: runtime.argv,
    browser: !globalThis.process?.versions?.node,
    version: globalThis.process?.version || processShim.version || "",
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
