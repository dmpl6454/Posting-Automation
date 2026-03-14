"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Redirect /dashboard/calendar → Content Studio Calendar tab
export default function CalendarRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/dashboard/content-agent?tab=calendar");
  }, [router]);
  return null;
}
