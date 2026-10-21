import { readdir, readFile } from "node:fs/promises";
import { resolve, relative, dirname, sep, extname } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const areas = [
  "apps/orchestrator",
  "apps/agent",
  "apps/dashboard",
  "apps/web",
  "packages/contracts",
  "packages/runtime",
];
interface Module {
  path: string;
  owner: string;
  imports: string[];
  client: boolean;
}
const modules = new Map<string, Module>();
const failures = new Set<string>();
const name = (path: string) => relative(root, path).split(sep).join("/");
async function collect(directory: string, owner: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await collect(path, owner);
      continue;
    }
    if (!/\.[cm]?tsx?$/.test(entry.name)) continue;
    const source = ts.createSourceFile(
      path,
      await readFile(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const module: Module = {
      path,
      owner,
      imports: [],
      client: source.statements.some(
        (node) =>
          ts.isExpressionStatement(node) &&
          ts.isStringLiteral(node.expression) &&
          node.expression.text === "use client",
      ),
    };
    function visit(node: ts.Node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        module.imports.push(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        if (node.arguments[0] && ts.isStringLiteral(node.arguments[0]))
          module.imports.push(node.arguments[0].text);
        else failures.add(`${name(path)} uses an uninspectable module import`);
      }
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      )
        module.imports.push(node.argument.literal.text);
      ts.forEachChild(node, visit);
    }
    visit(source);
    modules.set(path, module);
  }
}
for (const area of areas) await collect(resolve(root, area, "src"), area);
const exports = new Map<string, string>();
for (const area of ["contracts", "runtime"]) {
  const manifest = JSON.parse(
    await readFile(resolve(root, "packages", area, "package.json"), "utf8"),
  ) as { exports: Record<string, string> };
  for (const [key, target] of Object.entries(manifest.exports))
    exports.set(
      `@endercloud/${area}${key === "." ? "" : key.slice(1)}`,
      resolve(root, "packages", area, target),
    );
}
function target(module: Module, specifier: string): string | undefined {
  const path = specifier.startsWith(".")
    ? resolve(dirname(module.path), specifier)
    : specifier.startsWith("@/")
      ? resolve(root, module.owner, "src", specifier.slice(2))
      : exports.get(specifier);
  if (!path) return;
  return [
    path,
    ...(!extname(path)
      ? [path + ".ts", path + ".tsx", resolve(path, "index.ts"), resolve(path, "index.tsx")]
      : []),
  ].find((path) => modules.has(path));
}
const serverDependency =
  /^(node:|bun:|server-only$|@endercloud\/runtime|postgres(?:\/|$)|drizzle-orm(?:\/|$)|ioredis(?:\/|$)|dockerode(?:\/|$)|better-auth\/(minimal|api)|@better-auth\/(api-key|drizzle-adapter))/;
for (const module of modules.values()) {
  for (const specifier of module.imports) {
    const resolved = target(module, specifier);
    if (
      resolved &&
      name(resolved).startsWith("apps/") &&
      !name(resolved).startsWith(module.owner + "/")
    )
      failures.add(`${name(module.path)} imports another application: ${specifier}`);
    if (/^@endercloud\/(orchestrator|agent|dashboard|web)(\/|$)/.test(specifier))
      failures.add(`${name(module.path)} depends on an application package: ${specifier}`);
    if (
      module.owner === "apps/agent" &&
      /^(postgres|drizzle-orm|ioredis|yaml)(\/|$)/.test(specifier)
    )
      failures.add(`${name(module.path)} imports control-plane infrastructure: ${specifier}`);
  }
}
function browser(module: Module, origin: string, visited: Set<string>): void {
  if (visited.has(module.path)) return;
  visited.add(module.path);
  if (/\.server\.[cm]?tsx?$/.test(module.path))
    failures.add(`${name(origin)} reaches server-only module ${name(module.path)}`);
  for (const specifier of module.imports) {
    if (serverDependency.test(specifier))
      failures.add(
        `${name(origin)} reaches server dependency ${specifier} through ${name(module.path)}`,
      );
    const resolved = target(module, specifier);
    if (resolved) browser(modules.get(resolved)!, origin, visited);
  }
}
for (const module of modules.values())
  if (module.client || module.owner === "packages/contracts")
    browser(module, module.path, new Set());
if (failures.size) {
  console.error([...failures].join("\n"));
  process.exitCode = 1;
} else console.log("Application boundaries and transitive browser/server dependencies passed.");
