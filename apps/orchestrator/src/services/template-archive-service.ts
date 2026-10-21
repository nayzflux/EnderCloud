import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { eq } from "drizzle-orm";
import { pack } from "tar-stream";
import type { Database } from "../db/client.ts";
import { templateLayers } from "../db/schema.ts";

export class TemplateArchiveService {
  public constructor(private readonly db: Database) {}

  public async open(layerId: string, checksum: string): Promise<Response | null> {
    const rows = await this.db.select({
      templatePath: templateLayers.templatePath,
      checksum: templateLayers.checksum,
    }).from(templateLayers).where(eq(templateLayers.id, layerId)).limit(1);
    const layer = rows[0];
    if (!layer || layer.checksum !== checksum) return null;

    const archive = pack();
    const compressedArchive = createGzip();
    archive.pipe(compressedArchive);
    void this.appendDirectory(archive, layer.templatePath, layer.templatePath)
      .then(() => archive.finalize())
      .catch((error) => archive.destroy(error instanceof Error ? error : new Error(String(error))));
    return new Response(toWebStream(compressedArchive), {
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${layerId}-${checksum}.tar.gz"`,
        etag: `"${checksum}"`,
        "x-endercloud-template-checksum": checksum,
      },
    });
  }

  private async appendDirectory(
    archive: ReturnType<typeof pack>,
    root: string,
    directory: string,
  ): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error(`Template symlinks are forbidden: ${entry.name}`);
      const path = resolve(directory, entry.name);
      const name = relative(root, path).split(sep).join("/");
      if (entry.isDirectory()) {
        await this.addEntry(archive, { name: `${name}/`, type: "directory", mode: 0o755 });
        await this.appendDirectory(archive, root, path);
      } else if (entry.isFile()) {
        const metadata = await stat(path);
        await pipeline(createReadStream(path), archive.entry({
          name,
          type: "file",
          size: metadata.size,
          mode: 0o644,
        }));
      }
    }
  }

  private async addEntry(
    archive: ReturnType<typeof pack>,
    headers: Parameters<ReturnType<typeof pack>["entry"]>[0],
  ): Promise<void> {
    await new Promise<void>((resolveEntry, rejectEntry) => {
      const callback = (error?: Error | null) =>
        error ? rejectEntry(error) : resolveEntry();
      archive.entry(headers, callback).end();
    });
  }
}

function toWebStream(stream: Readable): ReadableStream<Uint8Array> {
  const iterator = stream[Symbol.asyncIterator]();

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) {
            controller.close();
            return;
          }
          controller.enqueue(
            next.value instanceof Uint8Array
              ? next.value
              : Buffer.from(next.value),
          );
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason) {
        await iterator.return?.();
        stream.destroy(reason instanceof Error ? reason : undefined);
      },
    },
    { highWaterMark: 1 },
  );
}
