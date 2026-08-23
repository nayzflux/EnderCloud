export const site = {
  name: "EnderCloud",
  description:
    "Automate ready capacity, party-aware matchmaking, multi-host placement, and cleanup for self-hosted Minecraft networks.",
  github: "https://github.com/nayzflux/EnderCloud",
};

export const siteUrl = new URL(
  process.env.SITE_URL ?? "http://localhost:3000",
);
