import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import type { TableHTMLAttributes } from "react";

function AccessibleTable(props: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div
      aria-label="Scrollable data table"
      className="prose-no-margin relative my-6 overflow-auto focus-visible:ring-2 focus-visible:ring-ring"
      role="region"
      tabIndex={0}
    >
      <table {...props} />
    </div>
  );
}

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    table: AccessibleTable,
    ...components,
  };
}
