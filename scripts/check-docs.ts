import { readdir, access, readFile } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";

const root = resolve(import.meta.dirname, "..");
const guides = resolve(root, "docs/guides");
const files = [resolve(root, "README.md"), resolve(root, "docs/README.md")];
async function collect(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.name.endsWith(".mdx")) files.push(path);
  }
}
await collect(guides);
const failures: string[] = [];
for (const path of files) {
  const source = (await readFile(path, "utf8")).replace(/```[^\n]*\n[\s\S]*?```/g, "");
  for (const match of source.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const link = match[1]!.split(/[?#]/)[0]!;
    if (!link || /^(https?:|mailto:|data:)/.test(link)) continue;
    const target = link === "/docs" ? resolve(guides, "index.mdx")
      : link.startsWith("/docs/") ? resolve(guides, link.slice(6) + ".mdx")
      : resolve(dirname(path), decodeURIComponent(link));
    try { await access(target); }
    catch { failures.push(`${relative(root, path)} links to missing ${link}`); }
  }
}
if (failures.length) { console.error(failures.join("\n")); process.exitCode = 1; }
else console.log(`Canonical documentation links passed (${files.length} files).`);
