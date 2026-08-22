import type { Metadata, Viewport } from "next";
import { AppSidebar } from "@/components/app-sidebar";
import { Providers } from "@/components/providers";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { isMockEnabled } from "@/lib/mock-data";
import "./globals.css";

export const metadata: Metadata = {
  title: "EnderCloud · Cluster control",
  description:
    "Read-only operations console for EnderCloud groups, instances, sessions and matchmaking queues.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "light dark",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const mockMode = isMockEnabled();

  return (
    <html
      lang="en"
      suppressHydrationWarning
    >
      <body className="min-h-svh bg-background font-sans antialiased">
        <a
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
      </body>
    </html>
  );
}
