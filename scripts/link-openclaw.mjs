import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";

const cwd = process.cwd();
const npmRoot = execFileSync("npm", ["root", "-g"], { cwd, encoding: "utf8" }).trim();
const source = path.join(npmRoot, "openclaw");
const targetDir = path.join(cwd, "node_modules");
const target = path.join(targetDir, "openclaw");

await fs.mkdir(targetDir, { recursive: true });

try {
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink()) {
    const linked = await fs.readlink(target);
    if (linked === source) {
      console.log(`openclaw already linked: ${target} -> ${source}`);
      process.exit(0);
    }
  }
  await fs.rm(target, { recursive: true, force: true });
} catch {
  // ignore
}

await fs.symlink(source, target, "dir");
console.log(`linked openclaw SDK: ${target} -> ${source}`);

