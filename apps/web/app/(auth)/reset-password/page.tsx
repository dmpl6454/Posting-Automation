"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Loader2, AlertCircle, CheckCircle2, ArrowRight, KeyRound } from "lucide-react";
import { trpc } from "~/lib/trpc/client";

export default function ResetPasswordPage() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const resetPassword = trpc.auth.resetPassword.useMutation({
    onSuccess: () => setSuccess(true),
    onError: (err: any) =>
      setError(err.message || "Failed to reset password. The link may have expired."),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    resetPassword.mutate({ token, password });
  };

  /* ── No token in URL ── */
  if (!token) {
    return (
      <div className="glass rounded-2xl p-8 fade-in text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10">
          <AlertCircle className="h-7 w-7 text-destructive" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Invalid link</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This password reset link is invalid or has expired.
        </p>
        <Link href="/forgot-password" className="mt-6 block">
          <Button className="h-11 w-full rounded-xl bg-foreground text-background hover:bg-foreground/90">
            Request a new link
          </Button>
        </Link>
      </div>
    );
  }

  /* ── Success ── */
  if (success) {
    return (
      <div className="glass rounded-2xl p-8 fade-in text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-green-500/10">
          <CheckCircle2 className="h-7 w-7 text-green-500" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Password reset!</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your password has been updated. You can now sign in with your new password.
        </p>
        <Link href="/login" className="mt-6 block">
          <Button className="h-11 w-full rounded-xl bg-foreground text-background hover:bg-foreground/90">
            <ArrowRight className="mr-2 h-4 w-4" />
            Go to Sign In
          </Button>
        </Link>
      </div>
    );
  }

  /* ── Reset form ── */
  return (
    <div className="glass rounded-2xl p-8 fade-in">
      {/* Header */}
      <div className="mb-6 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted/50">
          <KeyRound className="h-5 w-5 text-muted-foreground" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Reset password</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Choose a strong password — at least 8 characters.
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
          <Label htmlFor="password" className="text-sm font-medium">New password</Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Min. 8 characters"
            minLength={8}
            required
            autoFocus
            className="h-11 rounded-xl border-border/60 bg-background/50 transition-shadow focus:shadow-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="confirmPassword" className="text-sm font-medium">Confirm password</Label>
          <Input
            id="confirmPassword"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Repeat your password"
            minLength={8}
            required
            className="h-11 rounded-xl border-border/60 bg-background/50 transition-shadow focus:shadow-sm"
          />
        </div>
        <Button
          type="submit"
          disabled={resetPassword.isPending || !password || !confirmPassword}
          className="h-11 w-full rounded-xl bg-foreground text-background transition-all hover:bg-foreground/90 active:scale-[0.98]"
        >
          {resetPassword.isPending
            ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Resetting…</>
            : <><ArrowRight className="mr-2 h-4 w-4" />Reset Password</>
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
