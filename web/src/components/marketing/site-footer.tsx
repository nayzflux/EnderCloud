import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";
import { site } from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="site-shell flex flex-col gap-6 px-5 py-8 sm:flex-row sm:items-center sm:justify-between lg:px-8">
        <div className="flex items-center gap-4">
          <BrandMark />
          <span className="font-mono text-xs text-muted-foreground">SELF-HOSTED / OPEN SOURCE</span>
        </div>
        <nav aria-label="Footer navigation" className="flex items-center gap-5 text-sm text-muted-foreground">
          <Link className="hover:text-foreground" href="/docs">Docs</Link>
          <a className="hover:text-foreground" href={site.github} rel="noreferrer" target="_blank">GitHub</a>
          <a className="hover:text-foreground" href="#top">Back to top</a>
        </nav>
      </div>
    </footer>
  );
}
