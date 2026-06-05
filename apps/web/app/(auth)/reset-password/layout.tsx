import type { Metadata } from "next";

// BUG-18 / ADD-8: give /reset-password its own title (overrides the shared
// "Sign In" default from app/(auth)/layout.tsx).
export const metadata: Metadata = {
  title: "Set New Password",
  description: "Choose a new password for your PostAutomation account.",
};

export default function ResetPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}
