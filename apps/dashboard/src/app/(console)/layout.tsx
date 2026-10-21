import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDashboardSession } from "@/lib/server-session";
import { AppSidebar } from "@/components/app-sidebar";
import { Providers } from "@/components/providers";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { isMockEnabled } from "@/lib/mock-data";
export default async function ConsoleLayout({children}: Readonly<{children: React.ReactNode}>) {
  const request = new Request("http://dashboard/", {headers: await headers()});
  if (!await getDashboardSession(request)) redirect("/login");
  const mockMode = isMockEnabled();
  return <>        <a
          href="#main-content"
          className="sr-only rounded-lg bg-primary px-4 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50"
        >
          Skip to content
        </a>
        <Providers>
          <SidebarProvider>
            <AppSidebar mockMode={mockMode} />
            <SidebarInset className="min-w-0 overflow-hidden">
              <SiteHeader />
              <div
                id="main-content"
                className="flex min-w-0 flex-1 flex-col gap-5 p-4 md:p-6"
              >
                {children}
              </div>
            </SidebarInset>
          </SidebarProvider>
        </Providers>
</>;
}
