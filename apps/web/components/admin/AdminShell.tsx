"use client";

import { useState } from "react";
import { AdminSidebar } from "~/components/admin/AdminSidebar";
import { AdminHeader } from "~/components/admin/AdminHeader";

/**
 * Client shell for the admin console. Holds the mobile drawer state so the
 * AdminSidebar can render as a desktop rail (lg+) or a slide-in overlay drawer
 * (< lg) without permanently stealing 240px from content on phones/tablets.
 */
export function AdminShell({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="relative flex h-dvh">
      {/* Mobile drawer backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          aria-hidden="true"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <AdminSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <AdminHeader onMenuClick={() => setSidebarOpen(true)} />
        <main className="flex-1 overflow-y-auto bg-gray-50 p-4 sm:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
