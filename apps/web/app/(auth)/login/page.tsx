"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Loader2, AlertCircle, ArrowRight, Smartphone, Mail } from "lucide-react";
import { trpc } from "~/lib/trpc/client";

type LoginTab = "email" | "phone";
type PhoneStep = "enter-phone" | "enter-otp";

export default function LoginPage() {
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") || "/dashboard";

  const [tab, setTab] = useState<LoginTab>("email");

  // Email/password state
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // Phone OTP state
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [phoneStep, setPhoneStep] = useState<PhoneStep>("enter-phone");

  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const sendOtpMutation = trpc.auth.sendPhoneOtp.useMutation();

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    const result = await signIn("credentials", {
      email,
      password,
      loginType: "email",
      redirect: false,
    });
    if (result?.error) {
      setError("Invalid email or password");
    } else {
      window.location.href = callbackUrl;
    }
    setLoading(false);
  };

  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await sendOtpMutation.mutateAsync({ phone });
      setPhoneStep("enter-otp");
    } catch (err: any) {
      setError(err.message || "Failed to send OTP. Please try again.");
    }
    setLoading(false);
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    const result = await signIn("credentials", {
      phone,
      otp,
      loginType: "phone-otp",
      redirect: false,
    });
    if (result?.error) {
      setError("Invalid or expired OTP. Please try again.");
    } else {
      window.location.href = callbackUrl;
    }
    setLoading(false);
  };

  return (
    <div className="glass rounded-2xl p-8 fade-in">
      {/* Header */}
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Welcome back
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Sign in to your account to continue
        </p>
      </div>

      {/* OAuth Providers */}
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => signIn("google", { callbackUrl })}
          className="flex items-center justify-center gap-2 rounded-xl border border-border/60 bg-background/50 px-4 py-2.5 text-sm font-medium text-foreground transition-all hover:bg-background hover:shadow-sm active:scale-[0.98]"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
          </svg>
          Google
        </button>
        <button
          onClick={() => signIn("github", { callbackUrl })}
          className="flex items-center justify-center gap-2 rounded-xl border border-border/60 bg-background/50 px-4 py-2.5 text-sm font-medium text-foreground transition-all hover:bg-background hover:shadow-sm active:scale-[0.98]"
        >
          <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
          </svg>
          GitHub
        </button>
      </div>

      {/* Divider */}
      <div className="relative my-5">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-border/40" />
        </div>
        <div className="relative flex justify-center">
          <span className="bg-transparent px-3 text-xs text-muted-foreground/70 backdrop-blur-sm">
            or continue with
          </span>
        </div>
      </div>

      {/* Tab switcher */}
      <div className="mb-5 flex rounded-xl border border-border/60 bg-muted/30 p-1">
        <button
          type="button"
          onClick={() => { setTab("email"); setError(""); }}
          className={`flex flex-1 items-center justify-center gap-2 rounded-lg py-2 text-sm font-medium transition-all ${
            tab === "email"
              ? "bg-background shadow-sm text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Mail className="h-4 w-4" />
          Email
        </button>
        <button
          type="button"
          onClick={() => { setTab("phone"); setError(""); setPhoneStep("enter-phone"); }}
          className={`flex flex-1 items-center justify-center gap-2 rounded-lg py-2 text-sm font-medium transition-all ${
            tab === "phone"
              ? "bg-background shadow-sm text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Smartphone className="h-4 w-4" />
          Phone OTP
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 flex items-center gap-2.5 rounded-xl bg-destructive/8 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Email / Password form */}
      {tab === "email" && (
        <form onSubmit={handleEmailLogin} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email" className="text-sm font-medium">Email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              className="h-11 rounded-xl border-border/60 bg-background/50 transition-shadow focus:shadow-sm"
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="password" className="text-sm font-medium">Password</Label>
              <Link href="/forgot-password" className="text-xs text-muted-foreground transition-colors hover:text-foreground">
                Forgot password?
              </Link>
            </div>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              required
              className="h-11 rounded-xl border-border/60 bg-background/50 transition-shadow focus:shadow-sm"
            />
          </div>
          <Button
            type="submit"
            disabled={loading}
            className="h-11 w-full rounded-xl bg-foreground text-background transition-all hover:bg-foreground/90 active:scale-[0.98]"
          >
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowRight className="mr-2 h-4 w-4" />}
            {loading ? "Signing in..." : "Sign In"}
          </Button>
        </form>
      )}

      {/* Phone OTP — Step 1: enter phone */}
      {tab === "phone" && phoneStep === "enter-phone" && (
        <form onSubmit={handleSendOtp} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="phone" className="text-sm font-medium">Mobile Number</Label>
            <Input
              id="phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+91 98765 43210"
              required
              className="h-11 rounded-xl border-border/60 bg-background/50 transition-shadow focus:shadow-sm"
            />
            <p className="text-xs text-muted-foreground">
              Enter the number linked to your account. Include country code (e.g. +91).
            </p>
          </div>
          <Button
            type="submit"
            disabled={loading || !phone}
            className="h-11 w-full rounded-xl bg-foreground text-background transition-all hover:bg-foreground/90 active:scale-[0.98]"
          >
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Smartphone className="mr-2 h-4 w-4" />}
            {loading ? "Sending OTP..." : "Send OTP"}
          </Button>
        </form>
      )}

      {/* Phone OTP — Step 2: enter OTP */}
      {tab === "phone" && phoneStep === "enter-otp" && (
        <form onSubmit={handleVerifyOtp} className="space-y-4">
          <div className="rounded-xl border border-border/40 bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            OTP sent to{" "}
            <span className="font-medium text-foreground">{phone}</span>
            <button
              type="button"
              onClick={() => { setPhoneStep("enter-phone"); setOtp(""); setError(""); }}
              className="ml-2 text-xs underline hover:text-foreground"
            >
              Change
            </button>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="otp" className="text-sm font-medium">Enter 6-digit OTP</Label>
            <Input
              id="otp"
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
              placeholder="123456"
              required
              autoFocus
              className="h-11 rounded-xl border-border/60 bg-background/50 text-center text-lg tracking-[0.4em] transition-shadow focus:shadow-sm"
            />
            <p className="text-xs text-muted-foreground">Valid for 10 minutes</p>
          </div>
          <Button
            type="submit"
            disabled={loading || otp.length < 6}
            className="h-11 w-full rounded-xl bg-foreground text-background transition-all hover:bg-foreground/90 active:scale-[0.98]"
          >
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowRight className="mr-2 h-4 w-4" />}
            {loading ? "Verifying..." : "Verify & Sign In"}
          </Button>
          <button
            type="button"
            onClick={() => { setPhoneStep("enter-phone"); handleSendOtp({ preventDefault: () => {} } as any); }}
            disabled={loading}
            className="w-full text-center text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Didn&apos;t receive the OTP? Resend
          </button>
        </form>
      )}

      {/* Footer link */}
      <p className="mt-6 text-center text-sm text-muted-foreground">
        Don&apos;t have an account?{" "}
        <Link href="/register" className="font-medium text-foreground transition-colors hover:text-foreground/80">
          Create one
        </Link>
      </p>
    </div>
  );
}
