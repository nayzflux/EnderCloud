import type { NextConfig } from "next";
import { createMDX } from "fumadocs-mdx/next";

const nextConfig: NextConfig = {
  reactCompiler: true,
};

const withMDX = createMDX();

export default withMDX(nextConfig);
