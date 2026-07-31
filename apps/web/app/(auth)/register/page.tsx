"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  AuthShell,
  AuthHeader,
  AuthError,
  GoogleIcon,
  PlayIcon,
  navLinkStyle,
  cardStyle,
  labelStyle,
  inputStyle,
  googleBtnStyle,
  primaryBtnStyle,
} from "~/components/auth/AuthShell";

const REGISTER_GLOW =
  "radial-gradient(ellipse at 70% 20%, rgba(91,100,255,0.12) 0%, rgba(6,9,18,0) 55%), radial-gradient(ellipse at 30% 80%, rgba(47,107,255,0.1) 0%, rgba(6,9,18,0) 50%)";
const REGISTER_BLOBS = ["#1a3baa", "#2f6bff", "#5b64ff", "#0f2a7a", "#3d8bff"];

export default function RegisterPage() {
  const searchParams = useSearchParams();
  const invite = searchParams.get("invite");
  // If an invite token is present, route to /invite/<token> after registration
  // so acceptInvite fires. Otherwise fall back to the dashboard.
  const postRegisterDest = invite ? `/invite/${encodeURIComponent(invite)}` : "/dashboard";

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !email || !password) {
      setError("Please fill in all fields.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Registration failed");
      }

      // Auto sign in after registration
      await signIn("credentials", {
        email,
        password,
        callbackUrl: postRegisterDest,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
      setLoading(false);
    }
  };

  return (
    <AuthShell
      glow={REGISTER_GLOW}
      blobColors={REGISTER_BLOBS}
      navRight={
        <Link href="/login" className="pa-navlink" style={navLinkStyle}>
          Have an account? Sign In →
        </Link>
      }
    >
      <AuthHeader title="CREATE ACCOUNT" subtitle="Get started with PostAutomation for free" />

      <div className="pa-card" style={cardStyle}>
        {/* Google */}
        <button
          type="button"
          onClick={() => signIn("google", { callbackUrl: postRegisterDest })}
          className="pa-google"
          style={{ ...googleBtnStyle, marginBottom: 24 }}
        >
          <GoogleIcon />
          CONTINUE WITH GOOGLE
        </button>

        {/* divider */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 24 }}>
          <div style={{ flex: 1, height: 1, background: "rgba(120,160,255,0.16)" }} />
          <span
            style={{
              fontFamily: "'Chakra Petch',sans-serif",
              fontSize: 11,
              letterSpacing: "0.1em",
              color: "rgba(180,200,240,0.5)",
            }}
          >
            OR WITH EMAIL
          </span>
          <div style={{ flex: 1, height: 1, background: "rgba(120,160,255,0.16)" }} />
        </div>

        {error && <AuthError message={error} />}

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div>
            <label htmlFor="name" style={labelStyle}>
              FULL NAME
            </label>
            <input
              id="name"
              className="pa-input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="John Doe"
              required
              style={inputStyle}
            />
          </div>
          <div>
            <label htmlFor="email" style={labelStyle}>
              EMAIL ADDRESS
            </label>
            <input
              id="email"
              className="pa-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              style={inputStyle}
            />
          </div>
          <div>
            <label htmlFor="password" style={labelStyle}>
              PASSWORD
            </label>
            <input
              id="password"
              className="pa-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Min. 8 characters"
              minLength={8}
              required
              style={inputStyle}
            />
          </div>
          <button type="submit" disabled={loading} className="pa-primary" style={primaryBtnStyle(loading)}>
            <PlayIcon />
            {loading ? "CREATING ACCOUNT..." : "CREATE ACCOUNT"}
          </button>
        </form>

        <p
          style={{
            margin: "16px 0 0",
            textAlign: "center",
            fontSize: 11,
            color: "rgba(180,200,240,0.45)",
            lineHeight: 1.6,
          }}
        >
          By creating an account, you agree to our{" "}
          <Link href="/terms" style={{ color: "rgba(150,180,255,0.7)", textDecoration: "underline" }}>
            Terms
          </Link>{" "}
          and{" "}
          <Link href="/privacy" style={{ color: "rgba(150,180,255,0.7)", textDecoration: "underline" }}>
            Privacy Policy
          </Link>
        </p>
        <p style={{ margin: "16px 0 0", textAlign: "center", fontSize: 13, color: "rgba(180,200,240,0.6)" }}>
          Already have an account?{" "}
          <Link href="/login" className="pa-link" style={{ color: "#7fa6ff", textDecoration: "none", fontWeight: 600 }}>
            Sign in
          </Link>
        </p>
      </div>
    </AuthShell>
  );
}
