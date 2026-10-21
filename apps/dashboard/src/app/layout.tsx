import type { Metadata, Viewport } from "next";
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


  return (
    <html
      lang="en"
      suppressHydrationWarning
    >
      <body className="min-h-svh bg-background font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
