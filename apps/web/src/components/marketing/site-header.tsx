import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { MobileNav } from "@/components/marketing/mobile-nav";
import { buttonVariants } from "@/components/ui/button";
import { site } from "@/lib/site";
import { cn } from "@/lib/utils";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur-sm">
      <div className="site-shell flex h-16 items-center justify-between px-5 lg:px-8">
        <Link aria-label="EnderCloud home" href="/">
          <BrandMark />
        </Link>
        <nav aria-label="Main navigation" className="hidden items-center gap-7 md:flex">
          <a className="text-sm text-muted-foreground hover:text-foreground" href="#product">
            Product
          </a>
          <a className="text-sm text-muted-foreground hover:text-foreground" href="#solutions">
            Solutions
          </a>
          <Link className="text-sm text-muted-foreground hover:text-foreground" href="/docs">
            Docs
          </Link>
          <a
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "font-mono")}
            href={site.github}
            rel="noreferrer"
            target="_blank"
          >
            GitHub
            <ExternalLink aria-hidden="true" data-icon="inline-end" />
          </a>
        </nav>
        <MobileNav />
      </div>
    </header>
  );
}
