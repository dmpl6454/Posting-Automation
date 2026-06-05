import type { Metadata } from "next";
import { Providers } from "~/components/layout/providers";
import { DashboardShell } from "~/components/layout/dashboard-shell";

// ADD-8: give the authenticated app a sensible default title ("Dashboard |
// PostAutomation") instead of inheriting the marketing tagline. Individual
// dashboard routes can still override this with their own metadata export.
export const metadata: Metadata = {
  title: "Dashboard",
};

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Providers>
      <DashboardShell>{children}</DashboardShell>
    </Providers>
  );
}
