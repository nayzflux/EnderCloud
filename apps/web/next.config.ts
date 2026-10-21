import type { NextConfig } from "next";
import { resolve } from "node:path";
import { createMDX } from "fumadocs-mdx/next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: resolve(import.meta.dirname, "../.."),
  reactCompiler: true,
};

const withMDX = createMDX();

export default withMDX(nextConfig);
