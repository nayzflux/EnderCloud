import Link from "next/link";
import type { Metadata } from "next";
import {
  Activity,
  ArrowRight,
  Boxes,
  ExternalLink,
  GitBranch,
  Network,
  RadioTower,
  ShieldCheck,
} from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScreenshotPreview } from "@/components/marketing/screenshot-preview";
import { MotionProvider } from "@/components/marketing/motion-provider";
import { Reveal } from "@/components/marketing/reveal";
import { SiteFooter } from "@/components/marketing/site-footer";
import { SiteHeader } from "@/components/marketing/site-header";
import { site, siteUrl } from "@/lib/site";
import { cn } from "@/lib/utils";
import overviewScreenshot from "@/assets/dashboard/overview.png";
import topologyScreenshot from "@/assets/dashboard/topology.png";
import groupsScreenshot from "@/assets/dashboard/groups.png";
import instancesScreenshot from "@/assets/dashboard/instances.png";

export const metadata: Metadata = {
  title: "Minecraft server orchestrator and autoscaler",
  description:
    "EnderCloud is an open-source Minecraft server orchestrator and autoscaler. Run game servers on demand, keep warm capacity, match parties, and place servers across Docker hosts.",
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      name: site.name,
      url: siteUrl.href,
      logo: new URL("/icon.svg", siteUrl).href,
      sameAs: [site.github],
    },
    {
      "@type": "WebSite",
      name: site.name,
      url: siteUrl.href,
      description: site.description,
    },
    {
      "@type": "SoftwareApplication",
      name: site.name,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Linux, Docker",
      isAccessibleForFree: true,
      codeRepository: site.github,
      url: siteUrl.href,
      description: site.description,
      featureList: [
        "Minecraft game server autoscaling",
        "On-demand game server lifecycle management",
        "Party-aware matchmaking",
        "Multi-host Docker placement",
      ],
    },
  ],
};

const lifecycle = [
  {
    id: "01",
    name: "Ready before demand",
    description:
      "Keep game servers warm so a full queue does not have to wait for a container to boot.",
  },
  {
    id: "02",
    name: "Players get matched and reserved",
    description:
      "Build a match from queued players, assign them to one session, and reserve a ready server before transfer.",
  },
  {
    id: "03",
    name: "Players move automatically",
    description:
      "Send matched players through Velocity and track the session until the game ends.",
  },
  {
    id: "04",
    name: "Idle capacity disappears",
    description:
      "When the match ends, delete its server so the host can reuse the CPU and memory it occupied.",
  },
];

const features = [
  {
    icon: RadioTower,
    code: "CAPACITY / 01",
    title: "Servers ready before queues fill",
    description:
      "Set the ready capacity for each game mode. EnderCloud replenishes it as players consume available servers.",
  },
  {
    icon: ShieldCheck,
    code: "MATCHING / 02",
    title: "Matchmaking that keeps parties together",
    description:
      "Build a valid match from complete parties, then reserve one server for everyone selected.",
  },
  {
    icon: Network,
    code: "PLACEMENT / 03",
    title: "Capacity spread across every host",
    description:
      "Use the CPU and memory available across your Docker hosts without choosing a machine for every server.",
  },
  {
    icon: GitBranch,
    code: "CONFIG / 04",
    title: "Repeatable server versions",
    description:
      "Start every instance from revisioned templates so an update produces the same files and settings everywhere.",
  },
  {
    icon: Boxes,
    code: "RUNTIME / 05",
    title: "Paper and Velocity integration",
    description:
      "Let plugins join queues, report game state, submit results, and move players without managing infrastructure.",
  },
  {
    icon: Activity,
    code: "OPERATIONS / 06",
    title: "Problems visible in one place",
    description:
      "See every group, instance, host, queue, and incident before players have to report what went wrong.",
  },
];

const solutions = [
  "Choose a host from available CPU and memory",
  "Keep warm capacity balanced across machines",
  "Replace capacity before host maintenance",
  "Recover from the containers that are actually running",
];

export default function Home() {
  return (
    <div id="top" className="page-grid min-h-screen">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c"),
        }}
      />
      <SiteHeader />
      <MotionProvider>
        <main>
          <section className="site-shell border-b border-border px-5 pt-20 pb-0 lg:px-8 lg:pt-28">
            <div className="grid gap-12 lg:grid-cols-[minmax(0,1.45fr)_minmax(260px,0.55fr)] lg:gap-20">
              <div className="max-w-5xl">
                <Reveal delay={0.08}>
                  <h1 className="mt-7 max-w-5xl text-5xl leading-[0.96] font-semibold tracking-[-0.055em] text-balance sm:text-7xl lg:text-[6.25rem]">
                    Minecraft server orchestration, scaled by player demand
                  </h1>
                </Reveal>
                <Reveal delay={0.16}>
                  <p className="mt-8 max-w-3xl text-lg leading-8 text-muted-foreground sm:text-xl">
                    EnderCloud is an open-source Minecraft server orchestrator
                    and autoscaler for game networks. It keeps game servers
                    ready before queues fill, starts servers on demand as
                    players arrive, and stops idle instances across multiple
                    Docker hosts.
                  </p>
                </Reveal>
                <Reveal delay={0.24}>
                  <div className="mt-9 flex flex-wrap items-center gap-3">
                    <Link
                      className={cn(
                        buttonVariants({ size: "lg" }),
                        "light-action h-11 px-5 font-semibold",
                      )}
                      href="/docs"
                    >
                      Read the docs
                      <ArrowRight aria-hidden="true" data-icon="inline-end" />
                    </Link>
                    <a
                      className={cn(
                        buttonVariants({ variant: "outline", size: "lg" }),
                        "h-11 px-5",
                      )}
                      href={site.github}
                      rel="noreferrer"
                      target="_blank"
                    >
                      View on GitHub
                      <ExternalLink aria-hidden="true" data-icon="inline-end" />
                    </a>
                  </div>
                </Reveal>
              </div>
              <Reveal delay={0.18} direction="left">
                <aside className="border-t border-border pt-5 lg:mt-10">
                  <p className="technical-label">WHAT ENDERCLOUD SOLVES</p>
                  <dl className="mt-5 grid gap-0 font-mono text-xs">
                    <div className="grid grid-cols-2 gap-3 border-b border-border py-3">
                      <dt className="text-muted-foreground">
                        Different server types
                      </dt>
                      <dd className="text-right">Server variants</dd>
                    </div>
                    <div className="grid grid-cols-2 gap-3 border-b border-border py-3">
                      <dt className="text-muted-foreground">
                        Single-host overload
                      </dt>
                      <dd className="text-right">Load across multiple hosts</dd>
                    </div>
                    <div className="grid grid-cols-2 gap-3 border-b border-border py-3">
                      <dt className="text-muted-foreground">
                        Players wait for boot
                      </dt>
                      <dd className="text-right">Warm capacity</dd>
                    </div>
                    <div className="grid grid-cols-2 gap-3 border-b border-border py-3">
                      <dt className="text-muted-foreground">
                        Players need a match
                      </dt>
                      <dd className="text-right">
                        Matchmaking + reservations
                      </dd>
                    </div>
                    <div className="grid grid-cols-2 gap-3 py-3">
                      <dt className="text-muted-foreground">Match is over</dt>
                      <dd className="inline-flex items-center justify-end gap-2 text-right">
                        <span className="light-signal size-1.5 bg-signal" />
                        Automatic deletion
                      </dd>
                    </div>
                  </dl>
                </aside>
              </Reveal>
            </div>
            <div className="cross-mark mt-16 -mb-px lg:mt-24">
              <Reveal delay={0.28} variant="media">
                <ScreenshotPreview
                  alt="EnderCloud topology view showing server groups, warm capacity, queues, sessions, and running Minecraft instances"
                  description="See how queues, warm capacity, sessions, and live instances connect across the network."
                  emphasis="hero"
                  priority
                  src={topologyScreenshot}
                  title="Network topology"
                />
              </Reveal>
            </div>
          </section>

          <section id="product" className="site-shell border-b border-border">
            <div className="grid border-b border-border lg:grid-cols-[0.7fr_1.3fr]">
              <Reveal className="border-b border-border px-5 py-12 lg:border-r lg:border-b-0 lg:px-8 lg:py-20">
                <p className="technical-label">FROM QUEUE TO CLEANUP</p>
                <h2 className="mt-5 max-w-md text-4xl leading-tight font-semibold tracking-[-0.035em] sm:text-5xl">
                  Players get a ready server. You stop managing the lifecycle.
                </h2>
              </Reveal>
              <Reveal
                className="grid sm:grid-cols-2"
                delay={0.1}
                direction="left"
              >
                {lifecycle.map((step, index) => (
                  <article
                    className={cn(
                      "min-h-52 border-border p-6 lg:p-8",
                      index < 2 && "border-b",
                      index % 2 === 0 && "sm:border-r",
                    )}
                    key={step.name}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs text-primary">
                        {step.id}
                      </span>
                      <span className="size-2 bg-signal" />
                    </div>
                    <h3 className="mt-12 text-2xl font-semibold tracking-tight">
                      {step.name}
                    </h3>
                    <p className="mt-3 max-w-xs leading-7 text-muted-foreground">
                      {step.description}
                    </p>
                  </article>
                ))}
              </Reveal>
            </div>

            <div className="px-5 py-16 lg:px-8 lg:py-24">
              <Reveal className="max-w-3xl">
                <p className="technical-label">
                  FEATURES BUILT AROUND THE REAL WORK
                </p>
                <h2 className="mt-5 text-4xl font-semibold tracking-[-0.035em] sm:text-5xl">
                  Everything needed to run the network without babysitting it.
                </h2>
              </Reveal>
              <Reveal
                className="mt-12 grid border-t border-l border-border md:grid-cols-2 lg:grid-cols-3"
                delay={0.1}
              >
                {features.map(({ icon: Icon, code, title, description }) => (
                  <article
                    className="min-h-72 border-r border-b border-border bg-background p-6 lg:p-8"
                    key={title}
                  >
                    <div className="flex items-center justify-between text-primary">
                      <Icon aria-hidden="true" className="size-5" />
                      <span className="technical-label">{code}</span>
                    </div>
                    <h3 className="mt-16 text-2xl font-semibold tracking-tight">
                      {title}
                    </h3>
                    <p className="mt-3 leading-7 text-muted-foreground">
                      {description}
                    </p>
                  </article>
                ))}
              </Reveal>
            </div>
          </section>

          <section
            id="solutions"
            className="site-shell border-b border-border px-5 py-16 lg:px-8 lg:py-24"
          >
            <div className="grid gap-12 lg:grid-cols-[0.75fr_1.25fr] lg:gap-20">
              <Reveal>
                <p className="technical-label">
                  SOLUTION / MULTI-HOST OPERATIONS
                </p>
                <h2 className="mt-5 text-4xl font-semibold tracking-[-0.035em] sm:text-5xl">
                  Add hosts without adding more manual work.
                </h2>
                <p className="mt-6 max-w-xl text-lg leading-8 text-muted-foreground">
                  EnderCloud uses the capacity already available across your
                  machines. It chooses where each server runs, keeps ready
                  instances balanced, and moves capacity before a host goes into
                  maintenance.
                </p>
                <ol className="mt-10 border-t border-border">
                  {solutions.map((solution, index) => (
                    <li
                      className="flex items-center gap-5 border-b border-border py-4"
                      key={solution}
                    >
                      <span className="font-mono text-xs text-primary">
                        0{index + 1}
                      </span>
                      <span className="text-base font-medium">{solution}</span>
                      {index < solutions.length - 1 ? (
                        <ArrowRight
                          aria-hidden="true"
                          className="ml-auto size-4 text-muted-foreground"
                        />
                      ) : (
                        <span className="light-signal ml-auto size-2 bg-signal" />
                      )}
                    </li>
                  ))}
                </ol>
                <Link
                  className={cn(buttonVariants({ variant: "outline" }), "mt-8")}
                  href="/docs/configure/multi-host"
                >
                  See multi-host operations
                  <ArrowRight aria-hidden="true" data-icon="inline-end" />
                </Link>
              </Reveal>
              <Reveal delay={0.12} direction="left" variant="media">
                <ScreenshotPreview
                  alt="EnderCloud dashboard overview showing cluster health, warm capacity, active servers, players, and incidents"
                  description="The overview shows available capacity, active players, fleet health, and anything that needs attention."
                  emphasis="soft"
                  src={overviewScreenshot}
                  title="Network overview"
                />
              </Reveal>
            </div>
          </section>

          <section className="site-shell border-b border-border">
            <div className="grid border-b border-border lg:grid-cols-2">
              <Reveal className="border-b border-border px-5 py-12 lg:border-r lg:border-b-0 lg:px-8 lg:py-16">
                <p className="technical-label">
                  SOLUTION / CAPACITY AND MATCHMAKING
                </p>
                <h2 className="mt-5 max-w-xl text-4xl font-semibold tracking-[-0.035em]">
                  Change how a game mode runs without chasing settings across
                  services.
                </h2>
                <p className="mt-5 max-w-xl leading-7 text-muted-foreground">
                  Keep ready capacity, player limits, matchmaking rules, server
                  versions, and timeouts together. Operators can see the active
                  policy and the instances satisfying it.
                </p>
              </Reveal>
              <Reveal
                className="px-5 py-12 lg:px-8 lg:py-16"
                delay={0.1}
                direction="left"
              >
                <p className="technical-label">SOLUTION / LIVE INVENTORY</p>
                <h2 className="mt-5 max-w-xl text-4xl font-semibold tracking-[-0.035em]">
                  Know what is running, where it runs, and why.
                </h2>
                <p className="mt-5 max-w-xl leading-7 text-muted-foreground">
                  Filter servers by state, game mode, version, or host. When a
                  container fails or a process restarts, EnderCloud compares the
                  plan with what Docker is actually running.
                </p>
              </Reveal>
            </div>
            <div className="grid gap-px bg-border lg:grid-cols-2">
              <div className="bg-background p-3 sm:p-5">
                <Reveal variant="media">
                  <ScreenshotPreview
                    alt="EnderCloud server group detail with capacity policy, template variant, instances, and lifecycle activity"
                    description="Group detail exposes the policy and the instances currently satisfying it."
                    src={groupsScreenshot}
                    title="Server group operations"
                  />
                </Reveal>
              </div>
              <div className="bg-background p-3 sm:p-5">
                <Reveal delay={0.1} variant="media">
                  <ScreenshotPreview
                    alt="EnderCloud instance inventory listing lifecycle state, server group, host placement, and resource status"
                    description="The instance inventory provides a cluster-wide operational view of every runtime."
                    src={instancesScreenshot}
                    title="Instance inventory"
                  />
                </Reveal>
              </div>
            </div>
          </section>

          <section className="site-shell border-b border-border px-5 py-16 lg:px-8 lg:py-24">
            <div className="grid gap-12 lg:grid-cols-[0.65fr_1.35fr] lg:gap-20">
              <Reveal>
                <p className="technical-label">DOCUMENTATION</p>
                <h2 className="mt-5 text-4xl font-semibold tracking-[-0.035em] sm:text-5xl">
                  Configure the network without reverse-engineering the code.
                </h2>
                <p className="mt-6 leading-7 text-muted-foreground">
                  Follow the installation, set capacity and matchmaking rules,
                  add Docker hosts, then connect Paper and Velocity plugins.
                </p>
              </Reveal>
              <Reveal
                className="grid border-t border-l border-border sm:grid-cols-3"
                delay={0.1}
                direction="left"
              >
                {[
                  {
                    label: "Getting started",
                    number: "01",
                    href: "/docs/getting-started/overview",
                    text: "Install the stack and automate your first server group.",
                  },
                  {
                    label: "Configure and operate",
                    number: "02",
                    href: "/docs/configure/groups",
                    text: "Define groups, variants, hosts, and deadlines.",
                  },
                  {
                    label: "Integrate and develop",
                    number: "03",
                    href: "/docs/develop/minigame-integration",
                    text: "Connect plugins and work across the repository.",
                  },
                ].map((item) => (
                  <Link
                    className="group flex min-h-64 flex-col border-r border-b border-border p-6 hover:bg-muted/50"
                    href={item.href}
                    key={item.label}
                  >
                    <span className="font-mono text-xs text-primary">
                      {item.number}
                    </span>
                    <h3 className="mt-10 text-xl font-semibold">
                      {item.label}
                    </h3>
                    <p className="mt-3 text-sm leading-6 text-muted-foreground">
                      {item.text}
                    </p>
                    <ArrowRight
                      aria-hidden="true"
                      className="mt-auto size-4 transition-transform group-hover:translate-x-1"
                    />
                  </Link>
                ))}
              </Reveal>
            </div>
            <Separator className="my-16" />
            <Reveal className="flex flex-col items-start justify-between gap-8 sm:flex-row sm:items-end">
              <div>
                <p className="technical-label">
                  READY TO REMOVE THE MANUAL WORK?
                </p>
                <h2 className="mt-4 max-w-3xl text-3xl font-semibold tracking-[-0.03em] sm:text-5xl">
                  See how EnderCloud fits your network, then run it on your
                  infrastructure.
                </h2>
              </div>
              <div className="flex shrink-0 flex-wrap gap-3">
                <Link
                  className={cn(
                    buttonVariants({ size: "lg" }),
                    "light-action h-11 px-5",
                  )}
                  href="/docs"
                >
                  Open docs
                  <ArrowRight aria-hidden="true" data-icon="inline-end" />
                </Link>
                <a
                  className={cn(
                    buttonVariants({ variant: "outline", size: "lg" }),
                    "h-11 px-5",
                  )}
                  href={site.github}
                  rel="noreferrer"
                  target="_blank"
                >
                  GitHub
                  <ExternalLink aria-hidden="true" data-icon="inline-end" />
                </a>
              </div>
            </Reveal>
          </section>
        </main>
      </MotionProvider>
      <SiteFooter />
    </div>
  );
}
