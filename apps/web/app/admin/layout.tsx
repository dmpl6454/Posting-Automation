import { redirect } from "next/navigation";
import { auth } from "~/lib/auth";
import { Providers } from "~/components/layout/providers";
import { AdminShell } from "~/components/admin/AdminShell";
import { ImpersonationBanner } from "~/components/admin/ImpersonationBanner";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // /admin rides the NextAuth session (the legacy admin-token auth locked out
  // OAuth-only super admins). Middleware only checks cookie presence — this is
  // the authoritative server-side gate; admin DATA is additionally protected
  // by superAdminProcedure in packages/api.
  const session = await auth();
  if (!session?.user) {
    redirect("/login?callbackUrl=/admin");
  }
  const user = session.user as { isSuperAdmin?: boolean };
  if (user.isSuperAdmin !== true) {
    redirect("/dashboard");
  }

  return (
    <Providers>
      <ImpersonationBanner />
      <AdminShell>{children}</AdminShell>
    </Providers>
  );
}
