"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Redirect /dashboard/posts → Content Studio Posts tab
export default function PostsRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/dashboard/content-agent?tab=posts");
  }, [router]);
  return null;
}
