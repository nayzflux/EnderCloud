"use client";

import Link from "next/link";
import { ExternalLink, Menu } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { BrandMark } from "@/components/brand-mark";
import { site } from "@/lib/site";
import { cn } from "@/lib/utils";

const links = [
  { label: "Product", href: "/#product" },
  { label: "Solutions", href: "/#solutions" },
  { label: "Docs", href: "/docs" },
];

export function MobileNav() {
  return (
    <Sheet>
      <SheetTrigger
        aria-label="Open navigation"
        className={cn(buttonVariants({ variant: "outline", size: "icon" }), "md:hidden")}
      >
        <Menu aria-hidden="true" />
      </SheetTrigger>
      <SheetContent className="border-border bg-background" side="right">
        <SheetHeader className="border-b border-border p-5">
          <SheetTitle>
            <BrandMark />
          </SheetTitle>
          <SheetDescription>Navigate the EnderCloud website.</SheetDescription>
        </SheetHeader>
        <nav aria-label="Mobile navigation" className="grid p-5">
          {links.map((link) => (
            <SheetClose key={link.href} nativeButton={false} render={<Link href={link.href} />}>
              <span className="border-b border-border py-4 text-lg font-medium">
                {link.label}
              </span>
            </SheetClose>
          ))}
          <a
            className="mt-6 inline-flex items-center justify-between border border-border bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground"
            href={site.github}
            rel="noreferrer"
            target="_blank"
          >
            GitHub
            <ExternalLink aria-hidden="true" className="size-4" />
          </a>
        </nav>
      </SheetContent>
    </Sheet>
  );
}
