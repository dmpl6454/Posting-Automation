"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Redirect /dashboard/posts/bulk → Content Studio Bulk tab
export default function BulkRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/dashboard/content-agent?tab=bulk");
  }, [router]);
  return null;
}
