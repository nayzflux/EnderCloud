"use client";

import {
  FlaskConicalIcon,
  Gamepad2Icon,
  LayoutDashboardIcon,
  Layers3Icon,
  ListOrderedIcon,
  NetworkIcon,
  ServerIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";
import { useCluster } from "@/components/cluster-provider";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { formatNumber } from "@/lib/format";

interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
  readonly badge?: number;
}

export function AppSidebar({ mockMode = false }: { readonly mockMode?: boolean }) {
  const pathname = usePathname();
  const { snapshot } = useCluster();
  const summary = snapshot?.summary;

  const primary: readonly NavItem[] = [
    { href: "/", label: "Overview", icon: LayoutDashboardIcon },
    {
      href: "/groups",
      label: "Groups",
      icon: Layers3Icon,
      badge: snapshot?.groups.length,
    },
    {
      href: "/instances",
      label: "Instances",
      icon: ServerIcon,
      badge: summary?.activeInstances,
    },
    {
      href: "/sessions",
      label: "Sessions",
      icon: Gamepad2Icon,
      badge: summary?.activeSessions,
    },
    {
      href: "/queues",
      label: "Queues",
      icon: ListOrderedIcon,
      badge: summary?.queuedParties,
    },
  ];

  const views: readonly NavItem[] = [
    { href: "/topology", label: "Topology", icon: NetworkIcon },
  ];

  function isActive(href: string): boolean {
    return href === "/" ? pathname === "/" : pathname.startsWith(href);
  }

  function renderItems(items: readonly NavItem[]) {
    return items.map((item) => (
      <SidebarMenuItem key={item.href}>
        <SidebarMenuButton
          isActive={isActive(item.href)}
          tooltip={item.label}
          render={<Link href={item.href} />}
        >
          <item.icon />
          <span>{item.label}</span>
        </SidebarMenuButton>
        {item.badge === undefined || item.badge === 0 ? null : (
          <SidebarMenuBadge className="tabular">
            {formatNumber(item.badge)}
          </SidebarMenuBadge>
        )}
      </SidebarMenuItem>
    ));
  }

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              tooltip="EnderCloud"
              render={<Link href="/" />}
            >
              <span
                aria-hidden
                className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary font-mono text-xs font-semibold tracking-tighter text-primary-foreground"
              >
                EC
              </span>
              <span className="grid flex-1 text-left leading-tight">
                <span className="truncate font-medium">EnderCloud</span>
                <span className="truncate text-xs text-muted-foreground">
                  Cluster control
                </span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Monitoring</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{renderItems(primary)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Views</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{renderItems(views)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {mockMode ? (
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Synthetic data — DASHBOARD_MOCK_DATA is enabled"
                className="text-warning hover:text-warning"
              >
                <FlaskConicalIcon />
                <span className="truncate">Synthetic data</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      ) : null}

      <SidebarRail />
    </Sidebar>
  );
}
