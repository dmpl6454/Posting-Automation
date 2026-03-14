"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Redirect /dashboard/posts/new → Content Studio Compose tab
export default function NewPostRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/dashboard/content-agent?tab=compose");
  }, [router]);
  return null;
}
