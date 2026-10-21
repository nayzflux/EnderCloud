export const site = {
  name: "EnderCloud",
  description:
    "Open-source Minecraft server orchestrator and autoscaler for on-demand game servers, party-aware matchmaking, and multi-host networks.",
  github: "https://github.com/nayzflux/EnderCloud",
};

export const siteUrl = new URL(
  process.env.SITE_URL ?? "http://localhost:3000",
);
