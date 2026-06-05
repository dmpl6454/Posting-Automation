import type { Metadata } from "next";

// BUG-18 / ADD-8: give /register its own title. The page itself is a client
// component (can't export metadata), so a tiny server layout sets the title;
// nested-layout metadata overrides the shared "Sign In" default from
// app/(auth)/layout.tsx.
export const metadata: Metadata = {
  title: "Create Account",
  description: "Create your PostAutomation account to schedule and automate your social media.",
};

export default function RegisterLayout({ children }: { children: React.ReactNode }) {
  return children;
}
