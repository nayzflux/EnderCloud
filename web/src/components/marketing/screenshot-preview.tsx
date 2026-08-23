"use client";

import Image, { type StaticImageData } from "next/image";
import { Maximize2 } from "lucide-react";
import * as m from "motion/react-m";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type ScreenshotPreviewProps = {
  alt: string;
  className?: string;
  description: string;
  emphasis?: "hero" | "soft";
  priority?: boolean;
  src: StaticImageData;
  title: string;
};

export function ScreenshotPreview({
  alt,
  className,
  description,
  emphasis,
  priority = false,
  src,
  title,
}: ScreenshotPreviewProps) {
  return (
    <Dialog>
      <DialogTrigger
        aria-label={`Expand ${title} screenshot`}
        className={cn(
          "group relative block w-full cursor-zoom-in overflow-hidden border border-border bg-card text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
          emphasis === "hero" && "light-frame-hero",
          emphasis === "soft" && "light-frame-soft",
          className,
        )}
      >
        <Image
          alt={alt}
          className="h-auto w-full transition-[filter] duration-200 group-hover:brightness-110"
          placeholder="blur"
          priority={priority}
          sizes="(max-width: 768px) 100vw, 1280px"
          src={src}
        />
        {emphasis === "hero" ? (
          <m.span
            aria-hidden="true"
            className="light-sweep"
            initial={{ opacity: 0, skewX: -10, x: "-25%" }}
            transition={{
              delay: 0.35,
              duration: 0.85,
              ease: [0.16, 1, 0.3, 1],
              times: [0, 0.18, 1],
            }}
            viewport={{ amount: 0.35, once: true }}
            whileInView={{ opacity: [0, 0.62, 0], skewX: -10, x: ["-25%", "105%", "105%"] }}
          />
        ) : null}
        <span className="absolute right-3 bottom-3 inline-flex items-center gap-2 border border-border bg-background/95 px-2.5 py-1.5 font-mono text-[0.6875rem] uppercase">
          <Maximize2 aria-hidden="true" className="size-3" />
          Expand
        </span>
      </DialogTrigger>
      <DialogContent className="max-h-[94vh] max-w-[min(96vw,1600px)] overflow-auto border border-border bg-background p-3 sm:max-w-[min(96vw,1600px)]">
        <DialogHeader className="px-1 pt-1 pr-10">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Image
          alt={alt}
          className="h-auto w-full border border-border"
          placeholder="blur"
          sizes="96vw"
          src={src}
        />
      </DialogContent>
    </Dialog>
  );
}
