import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Button } from "~/components/ui/button";

export const metadata: Metadata = {
  title: "Page not found",
  description: "The page you are looking for could not be found.",
};

export default function NotFound() {
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-background px-4 text-center">
      {/* Ambient mesh gradient background */}
      <div className="pointer-events-none absolute inset-0 mesh-gradient" />

      {/* Floating orbs for depth */}
      <div className="pointer-events-none absolute -left-32 -top-32 h-96 w-96 rounded-full bg-indigo-500/[0.07] blur-3xl" />
      <div className="pointer-events-none absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-purple-500/[0.06] blur-3xl" />

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

      {/* 404 content */}
      <div className="relative z-10 flex flex-col items-center">
        <p className="text-7xl font-bold tracking-tight text-foreground sm:text-8xl">
          404
        </p>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight text-foreground">
          Page not found
        </h1>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          Sorry, we couldn&apos;t find the page you&apos;re looking for. It may
          have been moved or no longer exists.
        </p>

        <Button asChild size="lg" className="mt-8">
          <Link href="/">Go home</Link>
        </Button>
      </div>

      {/* Footer */}
      <p className="relative z-10 mt-12 text-xs text-muted-foreground/60">
        &copy; {new Date().getFullYear()} PostAutomation. All rights reserved.
      </p>
    </div>
  );
}
