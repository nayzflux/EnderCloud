declare module "tar-stream" {
  import type { Readable, Writable } from "node:stream";

  export interface Headers {
    name: string;
    type?: "file" | "directory" | "symlink" | "link";
    size?: number;
    mode?: number;
  }

  export interface Pack extends Readable {
    entry(headers: Headers, callback?: (error?: Error | null) => void): Writable;
    entry(headers: Headers, buffer: Buffer, callback?: (error?: Error | null) => void): Writable;
    finalize(): void;
    destroy(error?: Error): this;
  }

  export interface Extract extends Writable {
    on(
      event: "entry",
      listener: (headers: Headers, stream: Readable, next: (error?: Error | null) => void) => void,
    ): this;
    on(event: "finish", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
  }

  export function pack(): Pack;
  export function extract(): Extract;
}
