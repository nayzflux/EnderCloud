import type { ReactNode } from "react";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { BrandMark } from "@/components/brand-mark";
import { source } from "@/lib/source";
import { site } from "@/lib/site";

export default function DocumentationLayout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      links={[
        { text: "Product", url: "/", active: "none" },
        { text: "GitHub", url: site.github, external: true, active: "none" },
      ]}
      nav={{ title: <BrandMark />, url: "/" }}
      searchToggle={{ enabled: true }}
      themeSwitch={{ enabled: false }}
      tree={source.getPageTree()}
    >
      {children}
    </DocsLayout>
  );
}
