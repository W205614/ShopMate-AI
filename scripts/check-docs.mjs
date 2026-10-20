import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  cwd: root,
  encoding: "utf8",
}).split("\0"))].filter(file => file.endsWith(".md") && existsSync(resolve(root, file)));
const missing = [];
let checked = 0;
for (const file of files) {
  const content = readFileSync(resolve(root, file), "utf8");
  const links = [
    ...content.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g),
    ...content.matchAll(/<(?:img|a)\b[^>]*\b(?:src|href)=["']([^"']+)["']/g),
  ];
  for (const [, raw] of links) {
    const target = raw.replace(/^<|>$/g, "").split(/[?#]/)[0];
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
    checked++;
    if (!existsSync(resolve(dirname(resolve(root, file)), decodeURIComponent(target)))) {
      missing.push({ file, target });
    }
  }
}
console.log(JSON.stringify({ files: files.length, checked, missing }, null, 2));
if (missing.length) process.exitCode = 1;
