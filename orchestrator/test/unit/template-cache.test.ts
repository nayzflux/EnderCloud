import { expect, mock, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import { TemplateCache } from "../../src/agent/template-cache.ts";
import { inspectTemplateDirectory } from "../../src/configuration/sync.ts";

async function archive(
  entries: readonly { readonly name: string; readonly content: string }[],
): Promise<Buffer> {
  const stream = pack();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const completed = new Promise<Buffer>((resolve, reject) => {
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
  for (const entry of entries) {
    const bytes = Buffer.from(entry.content);
    stream.entry({ name: entry.name, type: "file", size: bytes.length }, bytes);
  }
  stream.finalize();
  return gzipSync(await completed);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("template cache downloads and verifies a valid layer only once", async () => {
  const root = await mkdtemp(join(tmpdir(), "endercloud-cache-"));
  const source = join(root, "source");
  const cacheRoot = join(root, "cache");
  await mkdir(source);
  await writeFile(join(source, "variant.yml"), "id: base-layer\n");
  await writeFile(join(source, "server.properties"), "motd=EnderCloud\n");
  const checksum = (await inspectTemplateDirectory(source)).checksum;
  const bytes = await archive([
    { name: "server.properties", content: "motd=EnderCloud\n" },
    { name: "variant.yml", content: "id: base-layer\n" },
  ]);
  const originalFetch = globalThis.fetch;
  const download = mock(async () => new Response(bytes));
  globalThis.fetch = download as unknown as typeof fetch;
  try {
    const cache = new TemplateCache(cacheRoot, "http://orchestrator:8080");
    const first = await cache.resolveLayers([{ id: "base-layer", checksum }]);
    const second = await cache.resolveLayers([{ id: "base-layer", checksum }]);

    expect(download).toHaveBeenCalledTimes(1);
    expect(second[0]?.templatePath).toBe(first[0]?.templatePath);
    expect(await readFile(join(first[0]!.templatePath, "server.properties"), "utf8"))
      .toBe("motd=EnderCloud\n");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("template cache rejects path traversal without writing outside staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "endercloud-cache-"));
  const cacheRoot = join(root, "cache");
  const bytes = await archive([{ name: "../../escape.txt", content: "escape" }]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () => new Response(bytes)) as unknown as typeof fetch;
  try {
    const cache = new TemplateCache(cacheRoot, "http://orchestrator:8080");
    await expect(cache.resolveLayers([
      { id: "base-layer", checksum: "a".repeat(64) },
    ])).rejects.toThrow("Unsafe tar entry");
    expect(await exists(join(root, "escape.txt"))).toBeFalse();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("template cache rejects a corrupted archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "endercloud-cache-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () => new Response("not a tar archive")) as unknown as typeof fetch;
  try {
    const cache = new TemplateCache(join(root, "cache"), "http://orchestrator:8080");
    await expect(cache.resolveLayers([
      { id: "base-layer", checksum: "a".repeat(64) },
    ])).rejects.toThrow();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
