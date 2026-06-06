"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Redirect /dashboard/posts → Content Studio (Recent Posts view)
export default function PostsRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/dashboard/content-agent?view=posts");
  }, [router]);
  return null;
}
