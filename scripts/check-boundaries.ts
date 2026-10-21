import { readdir, readFile } from "node:fs/promises";
import { resolve, relative, dirname, sep } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const failures: string[] = [];
async function inspect(directory: string, owner: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) { await inspect(path, owner); continue; }
    if (!/\.[cm]?tsx?$/.test(entry.name)) continue;
    const source = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node): void {
      let specifier: string | undefined;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifier = node.moduleSpecifier.text;
      if (specifier) {
        const target = specifier.startsWith(".") ? relative(root, resolve(dirname(path), specifier)).split(sep).join("/") : specifier;
        if (target.startsWith("apps/") && !target.startsWith(`${owner}/`)) failures.push(`${relative(root, path)} imports another application: ${specifier}`);
        if (owner === "packages/contracts" && /^(node:|bun:|@endercloud\/runtime)/.test(specifier)) failures.push(`${relative(root, path)} imports server code: ${specifier}`);
        if (owner === "apps/agent" && /^(postgres|drizzle-orm|ioredis|yaml)(\/|$)/.test(specifier)) failures.push(`${relative(root, path)} imports control-plane infrastructure: ${specifier}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
for (const area of ["apps/orchestrator", "apps/agent", "apps/dashboard", "apps/web", "packages/contracts", "packages/runtime"]) await inspect(resolve(root, area, "src"), area);
if (failures.length) { console.error(failures.join("\n")); process.exitCode = 1; }
else console.log("Application and browser/server boundaries passed.");
