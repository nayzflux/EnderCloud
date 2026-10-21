import type {
  ResolvedServerVariantConfig,
  TemplateLayerSpec,
  VariantRuntimeSpec,
} from "@endercloud/contracts/domain";
import { inspectTemplateDirectory } from "@endercloud/runtime/templates";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { parseGroup, parseVariant } from "./descriptors.ts";

function mergeRuntime(layers: readonly TemplateLayerSpec[], context: string): VariantRuntimeSpec {
  let dataDirectory = "/data";
  let image: string | undefined;
  let memoryBytes: number | undefined;
  let cpu: number | undefined;
  const environment: Record<string, string> = {};
  for (const layer of layers) {
    dataDirectory = layer.runtime.dataDirectory ?? dataDirectory;
    image = layer.runtime.image ?? image;
    memoryBytes = layer.runtime.memoryBytes ?? memoryBytes;
    cpu = layer.runtime.cpu ?? cpu;
    Object.assign(environment, layer.runtime.environment);
  }
  if (!image || memoryBytes === undefined || cpu === undefined) {
    throw new Error(`${context} does not resolve a complete docker image, memory and cpu runtime`);
  }
  return { image, memoryBytes, cpu, environment, dataDirectory };
}

function effectiveChecksum(layers: readonly TemplateLayerSpec[]): string {
  const hasher = createHash("sha256");
  for (const layer of layers) {
    hasher.update(layer.id);
    hasher.update("\0");
    hasher.update(layer.checksum);
    hasher.update("\0");
  }
  return hasher.digest("hex");
}

// Load all group and variant descriptors and verify their references.
export async function loadConfiguration(groupsRoot: string, templatesRoot: string) {
  const groupFiles = (await readdir(groupsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => join(groupsRoot, entry.name));
  // Group files are independent, so parse them concurrently during startup.
  const groups = await Promise.all(
    groupFiles.map(async (path) => parseGroup(parse(await readFile(path, "utf8")), path)),
  );
  if (new Set(groups.map((group) => group.id)).size !== groups.length)
    throw new Error("Duplicate group ids");
  const layers: TemplateLayerSpec[] = [];
  const manifests = new Map<string, ReadonlyMap<string, "directory" | "file">>();
  // Each template directory is optional until it contains a valid variant.yml descriptor.
  for (const entry of await readdir(templatesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const templatePath = resolve(templatesRoot, entry.name);
    const descriptor = join(templatePath, "variant.yml");
    try {
      const descriptorStat = await stat(descriptor);
      if (!descriptorStat.isFile()) continue;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        continue;
      throw error;
    }
    const variant = parseVariant(parse(await readFile(descriptor, "utf8")), descriptor);
    const inspected = await inspectTemplateDirectory(templatePath);
    layers.push({
      ...variant,
      templatePath,
      checksum: inspected.checksum,
      files: inspected.files,
    });
    manifests.set(variant.id, inspected.manifest);
  }
  const layersById = new Map<string, TemplateLayerSpec>();
  for (const layer of layers) {
    if (layersById.has(layer.id)) throw new Error(`Duplicate template layer id ${layer.id}`);
    layersById.set(layer.id, layer);
  }

  const finalIds = new Set(groups.flatMap((group) => group.variants.map((variant) => variant.id)));
  const variants: ResolvedServerVariantConfig[] = [];
  for (const id of finalIds) {
    const finalLayer = layersById.get(id);
    if (!finalLayer) throw new Error(`Group references unknown final variant ${id}`);
    if (finalLayer.revision === undefined) {
      throw new Error(`Final variant ${id} must define revision`);
    }
    if (finalLayer.parents.includes(id))
      throw new Error(`Final variant ${id} cannot parent itself`);
    const parents = finalLayer.parents.map((parentId) => {
      const parent = layersById.get(parentId);
      if (!parent) throw new Error(`Final variant ${id} references unknown parent ${parentId}`);
      if (parent.parents.length > 0) {
        throw new Error(`Parent layer ${parentId} cannot declare parents in flat inheritance`);
      }
      return parent;
    });
    const stack = [...parents, finalLayer];
    const observed = new Map<string, "directory" | "file">();
    for (const layer of stack) {
      for (const [path, kind] of manifests.get(layer.id) ?? []) {
        const previous = observed.get(path);
        if (previous && previous !== kind) {
          throw new Error(`Variant ${id} has a file/directory conflict at ${path}`);
        }
        observed.set(path, kind);
      }
    }
    variants.push({
      id,
      revision: finalLayer.revision,
      checksum: effectiveChecksum(stack),
      runtime: mergeRuntime(stack, `Final variant ${id}`),
      layers: stack,
    });
  }
  return { groups, layers, variants };
}
