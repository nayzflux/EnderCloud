import { ImageResponse } from "next/og";

export const alt = "EnderCloud — Minecraft server automation";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          alignItems: "stretch",
          background: "#191a1d",
          color: "#f0eaf4",
          display: "flex",
          flexDirection: "column",
          height: "100%",
          justifyContent: "space-between",
          padding: 64,
          position: "relative",
          width: "100%",
        }}
      >
        <div style={{ border: "1px solid #4a4c52", inset: 28, position: "absolute" }} />
        <div style={{ alignItems: "center", display: "flex", fontSize: 28, fontWeight: 700, gap: 16 }}>
          <div style={{ background: "#a867f4", display: "flex", height: 38, width: 38 }} />
          EnderCloud
        </div>
        <div style={{ display: "flex", flexDirection: "column", maxWidth: 1000 }}>
          <div style={{ color: "#a867f4", display: "flex", fontFamily: "monospace", fontSize: 18, letterSpacing: 3, marginBottom: 28 }}>
            AUTOMATED MINECRAFT SERVER OPERATIONS
          </div>
          <div style={{ display: "flex", fontSize: 70, fontWeight: 700, letterSpacing: -4, lineHeight: 1.03 }}>
            Stop running Minecraft servers by hand.
          </div>
        </div>
        <div style={{ alignItems: "center", display: "flex", fontFamily: "monospace", fontSize: 18, justifyContent: "space-between" }}>
          <span>VELOCITY → ORCHESTRATOR → AGENTS → DOCKER</span>
          <span style={{ color: "#8be3aa" }}>● SYSTEM READY</span>
        </div>
      </div>
    ),
    size,
  );
}
