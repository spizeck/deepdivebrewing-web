import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), "..");
const files = [];

const ignoredDirs = new Set(["node_modules", ".git", ".next", ".vercel", "dist", "out"]);

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (full.endsWith(".md")) files.push(full);
  }
}
walk(root);

const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
const failures = [];

for (const file of files) {
  const content = fs.readFileSync(file, "utf8");
  let match;
  while ((match = linkRegex.exec(content)) !== null) {
    const url = match[2];
    if (/^https?:\/\//.test(url) || url.startsWith("mailto:") || url.startsWith("#")) continue;
    const target = path.resolve(path.dirname(file), url.split("#")[0]);
    if (!fs.existsSync(target)) {
      failures.push(`${path.relative(root, file)} -> ${url}`);
    }
  }
}

if (failures.length) {
  console.log("Broken relative markdown links:");
  for (const failure of failures) console.log(failure);
  process.exit(1);
}

console.log("All relative markdown links resolve.");
