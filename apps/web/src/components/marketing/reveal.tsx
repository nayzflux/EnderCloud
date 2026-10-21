"use client";

import type { ReactNode } from "react";
import * as m from "motion/react-m";
import { cn } from "@/lib/utils";

type RevealProps = {
  children: ReactNode;
  className?: string;
  delay?: number;
  direction?: "left" | "right" | "up";
  variant?: "media" | "text";
};

const easeOutExpo = [0.16, 1, 0.3, 1] as const;

export function Reveal({
  children,
  className,
  delay = 0,
  direction = "up",
  variant = "text",
}: RevealProps) {
  const offset = variant === "media" ? 32 : 22;
  const initial = {
    opacity: 0,
    scale: variant === "media" ? 0.985 : 1,
    x: direction === "left" ? offset : direction === "right" ? -offset : 0,
    y: direction === "up" ? offset : 0,
  };

  return (
    <m.div
      className={cn(variant === "media" && "origin-bottom", className)}
      initial={initial}
      transition={{ delay, duration: variant === "media" ? 0.72 : 0.62, ease: easeOutExpo }}
      viewport={{ amount: 0.18, margin: "0px 0px -48px", once: true }}
      whileInView={{ opacity: 1, scale: 1, x: 0, y: 0 }}
    >
      {children}
    </m.div>
  );
}
