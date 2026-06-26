"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

const ERROR_MESSAGES: Record<string, { title: string; description: string }> = {
  Configuration: {
    title: "Configuration error",
    description:
      "The sign-in service is not fully configured. Please contact support or try a different sign-in method.",
  },
  AccessDenied: {
    title: "Access denied",
    description: "Your account does not have permission to sign in here.",
  },
  Verification: {
    title: "Verification failed",
    description: "The verification link has expired or already been used.",
  },
  OAuthSignin: {
    title: "Sign-in failed",
    description: "We couldn't reach the sign-in provider. Please try again.",
  },
  OAuthCallback: {
    title: "Sign-in callback failed",
    description: "The sign-in provider returned an unexpected response.",
  },
  OAuthCreateAccount: {
    title: "Could not create account",
    description: "We couldn't create your account from the provider profile. Please try again or use a different sign-in method.",
  },
  EmailCreateAccount: {
    title: "Could not create account",
    description: "We couldn't create your account from this email. Please try again or use a different sign-in method.",
  },
  Callback: {
    title: "Sign-in callback failed",
    description: "Something went wrong while finalising your sign-in. Please try again.",
  },
  OAuthAccountNotLinked: {
    title: "Account already exists",
    description:
      "An account with this email already exists. Sign in with the original method and link this provider from your account settings.",
  },
  EmailSignin: {
    title: "Could not send sign-in email",
    description: "We couldn't send the sign-in email. Please try again in a moment.",
  },
  CredentialsSignin: {
    title: "Invalid credentials",
    description: "Email or password is incorrect.",
  },
  SessionRequired: {
    title: "Sign-in required",
    description: "You need to be signed in to access that page.",
  },
  Default: {
    title: "Sign-in problem",
    description: "Something went wrong while signing you in. Please try again.",
  },
};

function ErrorContent() {
  const params = useSearchParams();
  const code = params.get("error") ?? "Default";
  const info = ERROR_MESSAGES[code] ?? ERROR_MESSAGES.Default!;
  return (
    <div className="mx-auto max-w-md space-y-6 rounded-xl border bg-card p-8 text-center shadow-sm">
      <h1 className="text-2xl font-bold">{info.title}</h1>
      <p className="text-muted-foreground">{info.description}</p>
      <div className="flex justify-center gap-3">
        <Link
          href="/login"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Back to sign in
        </Link>
        <Link
          href="/"
          className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
        >
          Home
        </Link>
      </div>
      <p className="text-xs text-muted-foreground">Error code: {code}</p>
    </div>
  );
}

export default function AuthErrorPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6">
      <Suspense fallback={null}>
        <ErrorContent />
      </Suspense>
    </main>
  );
}
