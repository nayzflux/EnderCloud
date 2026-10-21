import type { NextConfig } from "next";
import { resolve } from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: resolve(import.meta.dirname, "../.."),
  transpilePackages: ["@endercloud/contracts"],
  allowedDevOrigins: ["127.0.0.1"],
  reactCompiler: true,
};

export default nextConfig;
