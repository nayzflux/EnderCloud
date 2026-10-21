import { loader } from "fumadocs-core/source";
import { defineDocs } from "fumadocs-mdx/macro";

const docs = defineDocs({
  dir: "../../docs/guides",
});

export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});
