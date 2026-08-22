import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { extract } from "tar-stream";
import { inspectTemplateDirectory } from "../configuration/sync.ts";
import type { Logger } from "../logger.ts";

export interface RemoteTemplateLayer {
  readonly id: string;
  readonly checksum: string;
}

export interface CachedTemplateLayer extends RemoteTemplateLayer {
  readonly templatePath: string;
}

export class TemplateCache {
  private readonly downloads = new Map<string, Promise<string>>();

  public constructor(
    private readonly root: string,
    private readonly orchestratorUrl: string,
    private readonly logger?: Logger,
  ) {}

  public async resolveLayers(
    layers: readonly RemoteTemplateLayer[],
  ): Promise<readonly CachedTemplateLayer[]> {
    return Promise.all(layers.map(async (layer) => ({
      ...layer,
      templatePath: await this.ensureLayer(layer),
    })));
  }

  private async ensureLayer(layer: RemoteTemplateLayer): Promise<string> {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(layer.id)) {
      throw new Error(`Invalid template layer id ${layer.id}`);
    }
    if (!/^[a-f0-9]{64}$/.test(layer.checksum)) {
      throw new Error(`Invalid checksum for template layer ${layer.id}`);
    }
    const key = `${layer.id}:${layer.checksum}`;
    const existing = this.downloads.get(key);
    if (existing) return existing;
    const operation = this.downloadLayer(layer).finally(() => this.downloads.delete(key));
    this.downloads.set(key, operation);
    return operation;
  }

  private async downloadLayer(layer: RemoteTemplateLayer): Promise<string> {
    const layerRoot = join(this.root, layer.id);
    const destination = join(layerRoot, layer.checksum);
    if (await this.isDirectory(destination)) {
      this.logger?.debug("template.cache.hit", "Template layer cache hit", {
        layerId: layer.id,
        checksum: layer.checksum,
      });
      return destination;
    }
    const startedAt = performance.now();
    this.logger?.debug("template.cache.download_started", "Template layer download started", {
      layerId: layer.id,
      checksum: layer.checksum,
    });
    await mkdir(layerRoot, { recursive: true });
    const staging = join(layerRoot, `${layer.checksum}-staging-${crypto.randomUUID()}`);
    await mkdir(staging, { recursive: true });
    try {
      const url = new URL(
        `/api/v1/template-layers/${encodeURIComponent(layer.id)}/archive`,
        this.orchestratorUrl,
      );
      url.searchParams.set("checksum", layer.checksum);
      const response = await fetch(url);
      if (!response.ok || !response.body) {
        throw new Error(`Template download failed with HTTP ${response.status}`);
      }
      await this.extractArchive(response.body, staging);
      const inspected = await inspectTemplateDirectory(staging);
      if (inspected.checksum !== layer.checksum) {
        throw new Error(
          `Template ${layer.id} checksum mismatch: expected ${layer.checksum}, got ${inspected.checksum}`,
        );
      }
      await rm(destination, { recursive: true, force: true });
      await rename(staging, destination);
      this.logger?.debug("template.cache.download_completed", "Template layer download completed", {
        layerId: layer.id,
        checksum: layer.checksum,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return destination;
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async extractArchive(body: ReadableStream<Uint8Array>, destination: string): Promise<void> {
    const unpack = extract();
    const decompressor = createGunzip();
    const completed = new Promise<void>((resolveArchive, rejectArchive) => {
      unpack.on("entry", (header, stream, next) => {
        void (async () => {
          if (header.type !== "file" && header.type !== "directory") {
            throw new Error(`Unsupported tar entry type ${header.type ?? "unknown"}`);
          }
          const target = this.safeArchivePath(destination, header.name);
          if (header.type === "directory") {
            await mkdir(target, { recursive: true });
            stream.resume();
          } else {
            await mkdir(resolve(target, ".."), { recursive: true });
            await pipeline(stream, createWriteStream(target, { flags: "wx" }));
          }
        })().then(() => next(), (error) => next(error instanceof Error ? error : new Error(String(error))));
      });
      unpack.on("finish", resolveArchive);
      unpack.on("error", rejectArchive);
    });
    await Promise.all([
      pipeline(Readable.fromWeb(body as never), decompressor, unpack),
      completed,
    ]);
  }

  private safeArchivePath(root: string, name: string): string {
    const destination = resolve(root);
    const target = resolve(destination, name);
    const child = relative(destination, target);
    if (!child || isAbsolute(child) || child.startsWith("..")) {
      throw new Error(`Unsafe tar entry ${name}`);
    }
    return target;
  }

  private async isDirectory(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }
}
