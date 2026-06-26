import { Providers } from "~/components/layout/providers";
import { AdminShell } from "~/components/admin/AdminShell";
import { ImpersonationBanner } from "~/components/admin/ImpersonationBanner";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Providers>
      <ImpersonationBanner />
      <AdminShell>{children}</AdminShell>
    </Providers>
  );
}
