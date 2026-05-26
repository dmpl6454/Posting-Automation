"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Loader2, AlertCircle, CheckCircle2, ArrowLeft, Mail } from "lucide-react";
import { trpc } from "~/lib/trpc/client";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const requestReset = trpc.auth.requestPasswordReset.useMutation({
    onSuccess: () => setSubmitted(true),
    onError: (err: any) => setError(err.message || "Something went wrong. Please try again."),
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    requestReset.mutate({ email });
  };

  if (submitted) {
    return (
      <div className="glass rounded-2xl p-8 fade-in text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-green-500/10">
          <CheckCircle2 className="h-7 w-7 text-green-500" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Check your email</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          If an account exists for{" "}
          <span className="font-medium text-foreground">{email}</span>, we&apos;ve sent a password
          reset link. It expires in 1&nbsp;hour.
        </p>
        <p className="mt-3 text-xs text-muted-foreground">
          Didn&apos;t receive it? Check your spam folder.
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <Button
            variant="outline"
            onClick={() => { setSubmitted(false); setEmail(""); }}
            className="h-11 w-full rounded-xl"
          >
            Try another email
          </Button>
          <Link href="/login">
            <Button variant="ghost" className="h-11 w-full rounded-xl">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Sign In
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="glass rounded-2xl p-8 fade-in">
      {/* Header */}
      <div className="mb-6 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted/50">
          <Mail className="h-5 w-5 text-muted-foreground" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Forgot password?</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Enter your email and we&apos;ll send you a reset link.
        </p>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 flex items-center gap-2.5 rounded-xl bg-destructive/8 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="email" className="text-sm font-medium">Email</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            autoFocus
            className="h-11 rounded-xl border-border/60 bg-background/50 transition-shadow focus:shadow-sm"
          />
        </div>
        <Button
          type="submit"
          disabled={requestReset.isPending || !email}
          className="h-11 w-full rounded-xl bg-foreground text-background transition-all hover:bg-foreground/90 active:scale-[0.98]"
        >
          {requestReset.isPending
            ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Sending…</>
            : "Send Reset Link"
          }
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        Remember your password?{" "}
        <Link href="/login" className="font-medium text-foreground transition-colors hover:text-foreground/80">
          Sign in
        </Link>
      </p>
    </div>
  );
}
