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
    // The admin console follows the app theme (the design shows it dark).
    //
    // It was previously pinned to light because AdminShell/AdminHeader painted
    // hardcoded bg-white / bg-gray-50 with no dark: variants, so theme-aware
    // text turned near-white on those light surfaces and rows went invisible.
    // Those two surfaces now use bg-card / bg-background, so the pin is no
    // longer needed. ⚠️ If you add a hardcoded light surface here again, it
    // will be unreadable in dark mode — use the theme tokens.
    <Providers>
      <ImpersonationBanner />
      <AdminShell>{children}</AdminShell>
    </Providers>
  );
}
