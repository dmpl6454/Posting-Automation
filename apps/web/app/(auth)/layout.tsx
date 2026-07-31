import type { Metadata } from "next";
import { Providers } from "~/components/layout/providers";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sign In",
  description: "Sign in to your PostAutomation account to manage your social media.",
};

// The /login and /register pages render their own full-page dark shell
// (AuthShell — nav, animated glow, grid). This layout only supplies the
// session/query Providers; all chrome lives in the pages themselves.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <Providers>{children}</Providers>;
}
