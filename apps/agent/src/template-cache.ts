import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { extract } from "tar-stream";
import { inspectTemplateDirectory } from "@endercloud/runtime/templates";
import type { Logger } from "@endercloud/runtime/logger";

export interface RemoteTemplateLayer {
  readonly id: string;
  readonly checksum: string;
}

export interface CachedTemplateLayer extends RemoteTemplateLayer {
  readonly templatePath: string;
}

export interface TemplateCacheOptions {
  readonly timeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly maxExpandedBytes?: number;
  readonly maxEntries?: number;
  readonly concurrency?: number;
}

export class TemplateCache {
  private readonly shutdown = new AbortController();
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly downloads = new Map<string, Promise<string>>();

  public constructor(
    private readonly root: string,
    private readonly orchestratorUrl: string,
    private readonly logger?: Logger,
    private readonly options: TemplateCacheOptions = {},
  ) {}

  public async resolveLayers(
    layers: readonly RemoteTemplateLayer[],
  ): Promise<readonly CachedTemplateLayer[]> {
    return Promise.all(layers.map(async (layer) => ({
      ...layer,
      templatePath: await this.ensureLayer(layer),
    })));
  }

  public async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    for (const layer of await readdir(this.root, { withFileTypes: true })) {
      if (!layer.isDirectory() || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(layer.name)) continue;
      for (const entry of await readdir(join(this.root, layer.name), { withFileTypes: true })) {
        if (entry.isDirectory() && /^[a-f0-9]{64}-staging-[a-f0-9-]+$/.test(entry.name))
          await rm(join(this.root, layer.name, entry.name), { recursive: true, force: true });
      }
    }
  }

  public async close(): Promise<void> {
    this.shutdown.abort(new Error("Template cache is shutting down"));
    await Promise.allSettled(this.downloads.values());
  }

  private async withSlot<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= (this.options.concurrency ?? 4)) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active += 1;
    try { this.shutdown.signal.throwIfAborted(); return await task(); }
    finally { const next = this.waiting.shift(); if (next) next(); else this.active -= 1; }
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
    const operation = this.withSlot(() => this.downloadLayer(layer)).finally(() => this.downloads.delete(key));
    this.downloads.set(key, operation);
    return operation;
  }

  private async downloadLayer(layer: RemoteTemplateLayer): Promise<string> {
    const layerRoot = join(this.root, layer.id);
    const destination = join(layerRoot, layer.checksum);
    if (await this.isDirectory(destination) && (await inspectTemplateDirectory(destination).catch(() => null))?.checksum === layer.checksum) {
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Template download deadline exceeded")), this.options.timeoutMs ?? 300_000);
    const signal = AbortSignal.any([controller.signal, this.shutdown.signal]);
    try {
      const url = new URL(
        `/api/v1/template-layers/${encodeURIComponent(layer.id)}/archive`,
        this.orchestratorUrl,
      );
      url.searchParams.set("checksum", layer.checksum);
      const response = await fetch(url, { signal });
      if (!response.ok || !response.body) {
        throw new Error(`Template download failed with HTTP ${response.status}`);
      }
      await this.extractArchive(response.body, staging, signal);
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
    } finally { clearTimeout(timeout); }
  }

  private async extractArchive(body: ReadableStream<Uint8Array>, destination: string, signal: AbortSignal): Promise<void> {
    const unpack = extract();
    let entries = 0;
    let expandedBytes = 0;
    const idleController = new AbortController();
    const idle = () => idleController.abort(new Error("Template download made no progress"));
    const idleTimer = setTimeout(idle, this.options.idleTimeoutMs ?? 30_000);
    const extractionSignal = AbortSignal.any([signal, idleController.signal]);
    const progress = new Transform({ transform(chunk, _encoding, callback) {
      idleTimer.refresh(); callback(null, chunk);
    } });
    const maximum = this.options.maxExpandedBytes ?? 8 * 1024 ** 3;
    const quota = new Transform({ transform(chunk, _encoding, callback) {
      expandedBytes += chunk.length;
      callback(expandedBytes > maximum ? new Error("Template expanded size limit exceeded") : null, chunk);
    } });
    const decompressor = createGunzip();
    const completed = new Promise<void>((resolveArchive, rejectArchive) => {
      unpack.on("entry", (header, stream, next) => {
        void (async () => {
          if (header.type !== "file" && header.type !== "directory") {
            throw new Error(`Unsupported tar entry type ${header.type ?? "unknown"}`);
          }
          entries += 1;
          if (entries > (this.options.maxEntries ?? 100_000) || !Number.isSafeInteger(header.size ?? 0) || (header.size ?? 0) > maximum) throw new Error("Template archive limits exceeded");
          const target = this.safeArchivePath(destination, header.name);
          if (header.type === "directory") {
            await mkdir(target, { recursive: true });
            stream.resume();
          } else {
            await mkdir(resolve(target, ".."), { recursive: true });
            await pipeline(stream, createWriteStream(target, { flags: "wx" }), { signal: extractionSignal });
          }
        })().then(() => next(), (error) => next(error instanceof Error ? error : new Error(String(error))));
      });
      unpack.on("finish", resolveArchive);
      unpack.on("error", rejectArchive);
    });
    try {
      await Promise.all([pipeline(Readable.fromWeb(body as never), progress, decompressor, quota, unpack, { signal: extractionSignal }), completed]);
    } finally { clearTimeout(idleTimer); }
  }

  private safeArchivePath(root: string, name: string): string {
    const destination = resolve(root);
    const target = resolve(destination, name);
    const child = relative(destination, target);
    if (!child || isAbsolute(child) || child.startsWith("..") || /[\\:\x00-\x1f]/.test(name) || name.startsWith("/")) {
      throw new Error(`Unsafe tar entry ${name}`);
    }
    return target;
  }

  private async isDirectory(path: string): Promise<boolean> {
    try {
      return (await lstat(path)).isDirectory();
    } catch {
      return false;
    }
  }
}
