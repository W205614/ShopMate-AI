import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { check, resolveConfig } from "prettier";

const root = fileURLToPath(new URL("../../", import.meta.url));
process.chdir(root);

function gitPaths(args) {
  return execFileSync("git", args, { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

const base = process.argv[2] ?? "HEAD";
// GitHub reports an all-zero base on the first push of a branch.
const tracked = /^0+$/.test(base)
  ? gitPaths(["ls-files", "--cached", "-z"])
  : gitPaths(["diff", "--name-only", "--diff-filter=ACMRT", "-z", base, "--"]);
const untracked = gitPaths([
  "ls-files",
  "--others",
  "--exclude-standard",
  "-z",
]);
const files = [...new Set([...tracked, ...untracked])].filter((path) =>
  /^(backend|frontend|shared|scripts)\/.*\.(?:[cm]?[jt]sx?|vue|css)$/.test(
    path,
  ),
);

for (const filepath of files) {
  const source = await readFile(filepath, "utf8");
  const options = await resolveConfig(filepath);
  if (!(await check(source, { ...options, filepath }))) {
    console.error(filepath);
    process.exitCode = 1;
  }
}

console.log(`Prettier checked ${files.length} changed source files.`);
