import { Providers } from "~/components/layout/providers";
import { AdminSidebar } from "~/components/admin/AdminSidebar";
import { AdminHeader } from "~/components/admin/AdminHeader";
import { ImpersonationBanner } from "~/components/admin/ImpersonationBanner";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Providers>
      <ImpersonationBanner />
      <div className="flex h-screen">
        <AdminSidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <AdminHeader />
          <main className="flex-1 overflow-y-auto bg-gray-50 p-6">
            {children}
          </main>
        </div>
      </div>
    </Providers>
  );
}
