import type { Metadata } from "next";

// BUG-18 / ADD-8: give /forgot-password its own title (overrides the shared
// "Sign In" default from app/(auth)/layout.tsx). The page is a client
// component, so a tiny server layout supplies the metadata.
export const metadata: Metadata = {
  title: "Reset Password",
  description: "Reset your PostAutomation account password.",
};

export default function ForgotPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}
