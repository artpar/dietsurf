import { Buffer } from "buffer";
import { absPath } from "./path.js";

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

export function createFs(runtime) {
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
