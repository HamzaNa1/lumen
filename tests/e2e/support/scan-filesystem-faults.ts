import fs from "node:fs/promises";

// Delete after readdir supplied the entry, before the scanner stats it.
const vanish = process.env.LUMEN_E2E_VANISH_PATH
  ? await fs.realpath(process.env.LUMEN_E2E_VANISH_PATH)
  : undefined;
if (vanish) {
  const original = fs.lstat;
  fs.lstat = ((path, ...options) => {
    if (String(path) === vanish) return fs.unlink(path).then(() => original(path, ...options));
    return original(path, ...options);
  }) as typeof fs.lstat;
}

const unreadable = process.env.LUMEN_E2E_UNREADABLE_PATH
  ? await fs.realpath(process.env.LUMEN_E2E_UNREADABLE_PATH)
  : undefined;
if (unreadable) {
  const original = fs.readdir;
  fs.readdir = ((path, ...options) => {
    if (String(path) === unreadable)
      return Promise.reject(Object.assign(new Error("unreadable folder"), { code: "EACCES" }));
    return original(path, ...options);
  }) as typeof fs.readdir;
}
