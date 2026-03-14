import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Providers } from "~/components/layout/providers";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sign In",
  description: "Sign in to your PostAutomation account to manage your social media.",
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-background">
        {/* Ambient mesh gradient background */}
        <div className="pointer-events-none absolute inset-0 mesh-gradient" />

        {/* Floating orbs for depth */}
        <div className="pointer-events-none absolute -left-32 -top-32 h-96 w-96 rounded-full bg-indigo-500/[0.07] blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-purple-500/[0.06] blur-3xl" />
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-64 w-64 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan-500/[0.04] blur-3xl" />

        {/* Subtle grid pattern */}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.015] dark:opacity-[0.03]"
          style={{
            backgroundImage: `radial-gradient(circle at 1px 1px, currentColor 1px, transparent 0)`,
            backgroundSize: "32px 32px",
          }}
        />

        {/* Logo */}
        <Link
          href="/"
          className="relative z-10 mb-8 flex items-center gap-2.5 transition-opacity hover:opacity-80"
        >
          <Image
            src="/logo.png"
            alt="PostAutomation"
            width={40}
            height={40}
            className="h-10 w-10"
          />
          <span className="text-xl font-semibold tracking-tight text-foreground">
            PostAutomation
          </span>
        </Link>

        {/* Card container */}
        <div className="relative z-10 w-full max-w-[420px] px-4">
          {children}
        </div>

        {/* Footer */}
        <p className="relative z-10 mt-8 text-xs text-muted-foreground/60">
          &copy; {new Date().getFullYear()} PostAutomation. All rights reserved.
        </p>
      </div>
    </Providers>
  );
}
