import type { MetadataRoute } from "next";
import { source } from "@/lib/source";
import { siteUrl } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: siteUrl.toString() },
    ...source.getPages().map((page) => ({
      url: new URL(page.url, siteUrl).toString(),
    })),
  ];
}
