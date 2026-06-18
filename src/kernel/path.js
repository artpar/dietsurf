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

export function dirOf(path) {
  const clean = absPath(path);
  const idx = clean.lastIndexOf("/");
  return idx <= 0 ? "/" : clean.slice(0, idx);
}

export function baseName(path) {
  return String(path).replace(/\/$/, "").split("/").pop() || "";
}

export function wildcardRegex(pattern) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}
