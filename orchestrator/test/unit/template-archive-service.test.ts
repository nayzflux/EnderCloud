import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { extract } from "tar-stream";
import type { Database } from "../../src/db/client.ts";
import { TemplateArchiveService } from "../../src/services/template-archive-service.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

test("template archive service streams a complete gzip-compressed tar archive", async () => {
  const templatePath = await mkdtemp(join(tmpdir(), "endercloud-template-"));
  temporaryDirectories.push(templatePath);
  await mkdir(join(templatePath, "plugins"));
  await writeFile(join(templatePath, "server.properties"), "motd=EnderCloud\n");
  await writeFile(join(templatePath, "plugins", "config.yml"), "enabled: true\n");

  const checksum = "a".repeat(64);
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ templatePath, checksum }],
        }),
      }),
    }),
  } as unknown as Database;

  const response = await new TemplateArchiveService(db).open("base-layer", checksum);

  expect(response).not.toBeNull();
  expect(response?.headers.get("content-type")).toBe("application/gzip");
  expect(response?.headers.get("content-disposition")).toBe(
    `attachment; filename="base-layer-${checksum}.tar.gz"`,
  );
  const files = await readTarFiles(gunzipSync(new Uint8Array(await response!.arrayBuffer())));
  expect(files.get("server.properties")).toBe("motd=EnderCloud\n");
  expect(files.get("plugins/config.yml")).toBe("enabled: true\n");
});

async function readTarFiles(bytes: Uint8Array): Promise<Map<string, string>> {
  const archive = extract();
  const files = new Map<string, string>();
  const finished = new Promise<void>((resolveArchive, rejectArchive) => {
    archive.on("finish", resolveArchive);
    archive.on("error", rejectArchive);
  });

  archive.on("entry", (header, stream, next) => {
    const chunks: Uint8Array[] = [];
    stream.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    stream.on("end", () => {
      if (header.type === "file") {
        files.set(header.name, Buffer.concat(chunks).toString("utf8"));
      }
      next();
    });
    stream.resume();
  });

  archive.end(bytes);
  await finished;
  return files;
}
