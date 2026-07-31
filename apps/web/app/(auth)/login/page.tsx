"use client";

import { useState, type CSSProperties } from "react";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { trpc } from "~/lib/trpc/client";
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

type LoginTab = "email" | "phone";
type PhoneStep = "enter-phone" | "enter-otp";

const LOGIN_GLOW =
  "radial-gradient(ellipse at 50% 0%, rgba(47,107,255,0.14) 0%, rgba(6,9,18,0) 60%), radial-gradient(ellipse at 50% 100%, rgba(47,107,255,0.08) 0%, rgba(6,9,18,0) 50%)";

function tabStyle(active: boolean): CSSProperties {
  return {
    flex: 1,
    padding: 11,
    fontFamily: "'Chakra Petch',sans-serif",
    fontWeight: 600,
    fontSize: 11,
    letterSpacing: "0.1em",
    border: "none",
    cursor: "pointer",
    transition: "background .2s,color .2s",
    background: active ? "#2f6bff" : "rgba(8,14,32,0.5)",
    color: active ? "#fff" : "rgba(180,200,240,0.6)",
  };
}

export default function LoginPage() {
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") || "/dashboard";
  const invite = searchParams.get("invite");
  // If an invite token is present it takes priority: after auth send the user
  // back to /invite/<token> so acceptInvite fires. Otherwise use callbackUrl.
  const postLoginDest = invite ? `/invite/${encodeURIComponent(invite)}` : callbackUrl;

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
      // Check if this email is registered only via OAuth so we can give a
      // specific hint instead of the generic "invalid password" message.
      try {
        const res = await fetch(`/api/auth/check-email?email=${encodeURIComponent(email)}`);
        const { methods } = await res.json();
        const oauthProviders = methods.filter((m: string) => m !== "credentials");
        if (oauthProviders.length > 0 && !methods.includes("credentials")) {
          const names = oauthProviders
            .map((p: string) => p.charAt(0).toUpperCase() + p.slice(1))
            .join(" or ");
          setError(`This account was created with ${names}. Please use the ${names} button above to sign in.`);
        } else {
          setError("Invalid email or password");
        }
      } catch {
        setError("Invalid email or password");
      }
    } else {
      window.location.href = postLoginDest;
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send OTP. Please try again.");
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
      window.location.href = postLoginDest;
    }
    setLoading(false);
  };

  return (
    <AuthShell
      glow={LOGIN_GLOW}
      navRight={
        <Link href="/register" className="pa-navlink" style={navLinkStyle}>
          No account? Register →
        </Link>
      }
    >
      <AuthHeader title="WELCOME BACK" subtitle="Sign in to your account to continue" />

      <div className="pa-card" style={cardStyle}>
        {/* Google */}
        <button
          type="button"
          onClick={() => signIn("google", { callbackUrl: postLoginDest })}
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
            OR CONTINUE WITH
          </span>
          <div style={{ flex: 1, height: 1, background: "rgba(120,160,255,0.16)" }} />
        </div>

        {/* tabs */}
        <div
          style={{
            display: "flex",
            marginBottom: 26,
            border: "1px solid rgba(120,160,255,0.2)",
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          <button
            type="button"
            onClick={() => {
              setTab("email");
              setError("");
            }}
            style={tabStyle(tab === "email")}
          >
            ✉ EMAIL
          </button>
          <button
            type="button"
            onClick={() => {
              setTab("phone");
              setError("");
              setPhoneStep("enter-phone");
            }}
            style={tabStyle(tab === "phone")}
          >
            📱 PHONE OTP
          </button>
        </div>

        {error && <AuthError message={error} />}

        {/* Email / Password */}
        {tab === "email" && (
          <form onSubmit={handleEmailLogin} style={{ display: "flex", flexDirection: "column", gap: 18 }}>
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
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <label htmlFor="password" style={{ ...labelStyle, marginBottom: 0 }}>
                  PASSWORD
                </label>
                <Link
                  href="/forgot-password"
                  className="pa-link"
                  style={{
                    fontFamily: "'Chakra Petch',sans-serif",
                    fontSize: 10,
                    letterSpacing: "0.08em",
                    color: "rgba(150,180,255,0.7)",
                    textDecoration: "none",
                  }}
                >
                  FORGOT?
                </Link>
              </div>
              <input
                id="password"
                className="pa-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                required
                style={inputStyle}
              />
            </div>
            <button type="submit" disabled={loading} className="pa-primary" style={primaryBtnStyle(loading)}>
              <PlayIcon />
              {loading ? "SIGNING IN..." : "SIGN IN"}
            </button>
          </form>
        )}

        {/* Phone OTP — Step 1: enter phone */}
        {tab === "phone" && phoneStep === "enter-phone" && (
          <form onSubmit={handleSendOtp} style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div>
              <label htmlFor="phone" style={labelStyle}>
                MOBILE NUMBER
              </label>
              <input
                id="phone"
                className="pa-input"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+91 98765 43210"
                required
                style={inputStyle}
              />
              <p style={{ fontSize: 12, color: "rgba(180,200,240,0.5)", margin: "8px 0 0" }}>
                Include country code e.g. +91
              </p>
            </div>
            <button type="submit" disabled={loading || !phone} className="pa-primary" style={primaryBtnStyle(loading)}>
              <PlayIcon />
              {loading ? "SENDING..." : "SEND OTP"}
            </button>
          </form>
        )}

        {/* Phone OTP — Step 2: enter OTP */}
        {tab === "phone" && phoneStep === "enter-otp" && (
          <form onSubmit={handleVerifyOtp} style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div
              style={{
                background: "rgba(47,107,255,0.1)",
                border: "1px solid rgba(120,160,255,0.24)",
                padding: "12px 16px",
                borderRadius: 8,
                fontSize: 13,
                color: "rgba(205,216,245,0.8)",
              }}
            >
              OTP sent to <strong style={{ color: "#eef3ff" }}>{phone}</strong>
              <button
                type="button"
                onClick={() => {
                  setPhoneStep("enter-phone");
                  setOtp("");
                  setError("");
                }}
                style={{
                  background: "none",
                  border: "none",
                  color: "rgba(150,180,255,0.8)",
                  fontSize: 11,
                  cursor: "pointer",
                  marginLeft: 10,
                  textDecoration: "underline",
                }}
              >
                Change
              </button>
            </div>
            <div>
              <label htmlFor="otp" style={labelStyle}>
                ENTER 6-DIGIT OTP
              </label>
              <input
                id="otp"
                className="pa-input"
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="1 2 3 4 5 6"
                required
                autoFocus
                style={{
                  ...inputStyle,
                  fontFamily: "'Chakra Petch',sans-serif",
                  fontSize: 22,
                  letterSpacing: "0.4em",
                  textAlign: "center",
                }}
              />
              <p style={{ fontSize: 12, color: "rgba(180,200,240,0.5)", margin: "8px 0 0" }}>Valid for 10 minutes</p>
            </div>
            <button
              type="submit"
              disabled={loading || otp.length < 6}
              className="pa-primary"
              style={primaryBtnStyle(loading)}
            >
              <PlayIcon />
              {loading ? "VERIFYING..." : "VERIFY & SIGN IN"}
            </button>
            <button
              type="button"
              onClick={() => {
                setPhoneStep("enter-phone");
                void handleSendOtp({ preventDefault: () => {} } as React.FormEvent);
              }}
              disabled={loading}
              style={{
                width: "100%",
                textAlign: "center",
                fontSize: 12,
                color: "rgba(180,200,240,0.6)",
                background: "none",
                border: "none",
                cursor: "pointer",
              }}
            >
              Didn&apos;t receive the OTP? Resend
            </button>
          </form>
        )}

        {/* footer */}
        <p style={{ margin: "24px 0 0", textAlign: "center", fontSize: 13, color: "rgba(180,200,240,0.6)" }}>
          Don&apos;t have an account?{" "}
          <Link href="/register" className="pa-link" style={{ color: "#7fa6ff", textDecoration: "none", fontWeight: 600 }}>
            Create one
          </Link>
        </p>
      </div>
    </AuthShell>
  );
}
