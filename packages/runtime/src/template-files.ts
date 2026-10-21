import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, lstat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { TemplateFileSummary } from '@endercloud/contracts/domain';

export interface InspectedTemplate {
  readonly checksum: string;
  readonly files: TemplateFileSummary;
  readonly manifest: ReadonlyMap<string, "directory" | "file">;
}

// Hash a layer and collect bounded metadata used by validation and the dashboard.
export async function inspectTemplateDirectory(root: string, options: {signal?: AbortSignal; maxBytes?: number; maxEntries?: number} = {}): Promise<InspectedTemplate> {
  options.signal?.throwIfAborted();
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error("Template root must be a real directory");
  const hasher = createHash("sha256").update("endercloud-template-v2\0");
  const manifest = new Map<string, "directory" | "file">();
  const roots = new Set<string>();
  let fileCount = 0;
  let totalBytes = 0;
  let bytes = 0;
  let entryCount = 0;
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    // Filesystem enumeration order is unstable; sorting makes the checksum reproducible.
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    // Hash both relative paths and bytes so renames and content changes alter the revision.
    for (const entry of entries) {
      options.signal?.throwIfAborted();
      if (++entryCount > (options.maxEntries ?? 100_000)) throw new Error("Template entry limit exceeded");
      const path = join(directory, entry.name);
      const relativePath = relative(root, path).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        throw new Error(`Template symlinks are forbidden: ${path}`);
      }
      if (entry.isDirectory()) {
        hasher.update(`D${Buffer.byteLength(relativePath)}:${relativePath};`);
        manifest.set(relativePath, "directory");
        roots.add(relativePath.split("/")[0]!);
        await visit(path);
      }
      else if (entry.isFile()) {
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Template entry changed during inspection");
        bytes += metadata.size;
        if (bytes > (options.maxBytes ?? 8 * 1024 ** 3)) throw new Error("Template size limit exceeded");
        hasher.update(`F${Buffer.byteLength(relativePath)}:${relativePath}:${metadata.size}:`);
        for await (const chunk of createReadStream(path, options.signal ? {signal: options.signal} : {})) hasher.update(chunk);
        const after = await lstat(path);
        if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs || after.ino !== metadata.ino) throw new Error("Template changed during inspection");
        if (relativePath !== "variant.yml") {
          manifest.set(relativePath, "file");
          roots.add(relativePath.split("/")[0]!);
          fileCount += 1;
          totalBytes += metadata.size;
        }
      } else throw new Error(`Unsupported template entry: ${path}`);
    }
  }
  await visit(root);
  return {
    checksum: hasher.digest("hex"),
    files: { fileCount, totalBytes, roots: [...roots].sort() },
    manifest,
  };
}

