import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Timeline } from "../src/components/timeline";

test("renders the active deadline name next to its timeline marker", () => {
  const html = renderToStaticMarkup(
    <Timeline
      steps={[
        { id: "created", label: "Created", at: "2026-07-31T08:00:00.000Z" },
        { id: "ready", label: "Ready", at: "2026-07-31T08:01:00.000Z" },
        { id: "draining", label: "Draining", at: null },
        { id: "stopped", label: "Stopped", at: null },
      ]}
      deadline={{
        label: "Instance renewal deadline",
        at: "2026-07-31T12:01:00.000Z",
      }}
    />,
  );

  expect(html).toContain("Instance renewal deadline");
});
