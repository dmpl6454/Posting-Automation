"use client";

import { type CSSProperties, type ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";

/**
 * Shared chrome for the /login and /register pages — a port of the Claude Design
 * "PostAutomation Login/Register" screens (dark #060912 shell, ambient glow,
 * blueprint grid, top nav). The pages render their own glass card inside.
 *
 * The design's animated <canvas> glow was replaced with CSS gradient orbs: the
 * canvas re-blurred the whole viewport every frame (software 2D-ctx blur, and
 * even via CSS the compositor re-blurred a full-screen layer per frame) which
 * pegged the main thread and froze the tab. CSS orbs blur once and only animate
 * a cheap GPU transform — same ambient look, no jank.
 */

const SHELL_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800&family=Chakra+Petch:wght@400;500;600;700&display=swap');
@keyframes paFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
@keyframes paDriftA{0%,100%{transform:translate(0,0)}50%{transform:translate(6%,5%)}}
@keyframes paDriftB{0%,100%{transform:translate(0,0)}50%{transform:translate(-5%,-4%)}}
@keyframes paDriftC{0%,100%{transform:translate(0,0)}50%{transform:translate(4%,-5%)}}
.pa-auth input:-webkit-autofill{-webkit-box-shadow:0 0 0 100px #0c1530 inset!important;-webkit-text-fill-color:#eef3ff!important;}
.pa-auth .pa-input:focus{border-color:rgba(120,160,255,0.6)!important;box-shadow:0 0 0 2px rgba(47,107,255,0.14)!important;}
.pa-auth .pa-google:hover{border-color:rgba(120,160,255,0.5)!important;background:rgba(255,255,255,0.1)!important;}
.pa-auth .pa-primary:not(:disabled):hover{opacity:0.9!important;}
.pa-auth .pa-navlink:hover{color:#eef3ff!important;}
.pa-auth .pa-link:hover{color:#a0c0ff!important;}
.pa-orb{position:fixed;border-radius:50%;pointer-events:none;z-index:0;filter:blur(70px);opacity:0.5;will-change:transform;}
@media (prefers-reduced-motion:reduce){.pa-orb,.pa-auth [style*="paFloat"]{animation:none!important;}}
@media (max-width:520px){
  .pa-auth nav{padding:16px 18px!important;}
  .pa-auth .pa-brand-word{display:none!important;}
  .pa-auth .pa-navlink{font-size:11px!important;letter-spacing:0.1em!important;}
  .pa-auth .pa-card{padding:28px 20px!important;}
  .pa-orb{filter:blur(50px)!important;}
}
`;

const DEFAULT_BLOBS = ["#2f6bff", "#1a3baa", "#3d8bff"];

function orb(color: string, extra: CSSProperties): CSSProperties {
  return {
    width: "min(62vw,720px)",
    height: "min(62vw,720px)",
    background: `radial-gradient(circle, ${color} 0%, rgba(0,0,0,0) 68%)`,
    ...extra,
  };
}

export function AuthShell({
  navRight,
  glow,
  blobColors = DEFAULT_BLOBS,
  children,
}: {
  navRight: ReactNode;
  glow: string;
  blobColors?: string[];
  children: ReactNode;
}) {
  const cA = blobColors[0] ?? "#2f6bff";
  const cB = blobColors[1] ?? "#1a3baa";
  const cC = blobColors[2] ?? "#3d8bff";

  return (
    <div
      className="pa-auth"
      style={{
        minHeight: "100vh",
        background: "#060912",
        fontFamily: "'Archivo',sans-serif",
        color: "#eef3ff",
        display: "flex",
        flexDirection: "column",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: SHELL_CSS }} />

      {/* ambient glow — cheap CSS orbs */}
      <div aria-hidden="true" className="pa-orb" style={orb(cA, { top: "-14%", left: "-8%", animation: "paDriftA 16s ease-in-out infinite" })} />
      <div aria-hidden="true" className="pa-orb" style={orb(cB, { bottom: "-18%", right: "-10%", opacity: 0.45, animation: "paDriftB 20s ease-in-out infinite" })} />
      <div aria-hidden="true" className="pa-orb" style={orb(cC, { top: "28%", left: "38%", opacity: 0.32, animation: "paDriftC 24s ease-in-out infinite" })} />

      {/* radial tint */}
      <div aria-hidden="true" style={{ position: "fixed", inset: 0, zIndex: 1, pointerEvents: "none", background: glow }} />
      {/* blueprint grid */}
      <div
        aria-hidden="true"
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 1,
          pointerEvents: "none",
          opacity: 0.06,
          backgroundImage:
            "linear-gradient(rgba(120,160,255,1) 1px,transparent 1px),linear-gradient(90deg,rgba(120,160,255,1) 1px,transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />

      {/* nav */}
      <nav
        style={{
          position: "relative",
          zIndex: 10,
          padding: "24px 40px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Link
          href="/"
          style={{ display: "flex", alignItems: "center", gap: 11, textDecoration: "none", color: "#eef3ff" }}
        >
          <Image
            src="/logo.png"
            alt="PostAutomation"
            width={32}
            height={32}
            style={{ width: 32, height: 32, display: "block", filter: "drop-shadow(0 0 8px rgba(47,107,255,0.7))" }}
          />
          <span
            className="pa-brand-word"
            style={{ fontFamily: "'Chakra Petch',sans-serif", fontWeight: 700, letterSpacing: "0.22em", fontSize: 15 }}
          >
            POSTAUTOMATION
          </span>
        </Link>
        {navRight}
      </nav>

      {/* centered card slot */}
      <div
        style={{
          position: "relative",
          zIndex: 10,
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px 20px 48px",
        }}
      >
        <div style={{ width: "100%", maxWidth: 420 }}>{children}</div>
      </div>
    </div>
  );
}

/* ---------- shared bits used by both auth pages ---------- */

export const navLinkStyle: CSSProperties = {
  fontFamily: "'Chakra Petch',sans-serif",
  fontWeight: 600,
  fontSize: 12,
  letterSpacing: "0.14em",
  color: "rgba(205,216,245,0.7)",
  textDecoration: "none",
};

export const cardStyle: CSSProperties = {
  background: "rgba(12,20,42,0.6)",
  border: "1px solid rgba(120,160,255,0.2)",
  backdropFilter: "blur(16px)",
  WebkitBackdropFilter: "blur(16px)",
  padding: "34px 32px",
  borderRadius: 14,
};

export const labelStyle: CSSProperties = {
  display: "block",
  fontFamily: "'Chakra Petch',sans-serif",
  fontSize: 11,
  letterSpacing: "0.12em",
  color: "rgba(180,200,240,0.7)",
  fontWeight: 600,
  marginBottom: 8,
};

export const inputStyle: CSSProperties = {
  width: "100%",
  background: "rgba(8,14,32,0.7)",
  border: "1px solid rgba(120,160,255,0.22)",
  color: "#eef3ff",
  fontFamily: "'Archivo',sans-serif",
  fontSize: 15,
  padding: "13px 16px",
  outline: "none",
  borderRadius: 8,
};

export const googleBtnStyle: CSSProperties = {
  display: "flex",
  width: "100%",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(150,180,255,0.22)",
  color: "#eef3ff",
  fontFamily: "'Chakra Petch',sans-serif",
  fontWeight: 600,
  fontSize: 12,
  letterSpacing: "0.12em",
  padding: "13px 20px",
  cursor: "pointer",
  borderRadius: 8,
  transition: "border-color .2s,background .2s",
};

export function primaryBtnStyle(loading: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    width: "100%",
    padding: 15,
    background: "linear-gradient(135deg,#3d8bff,#2f6bff)",
    color: "#fff",
    border: "none",
    fontFamily: "'Chakra Petch',sans-serif",
    fontWeight: 700,
    fontSize: 13,
    letterSpacing: "0.14em",
    cursor: loading ? "default" : "pointer",
    borderRadius: 8,
    boxShadow: "0 10px 28px -10px rgba(47,107,255,0.7)",
    transition: "opacity .2s",
    opacity: loading ? 0.6 : 1,
  };
}

export function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  );
}

export function PlayIcon() {
  return (
    <svg width="9" height="11" viewBox="0 0 9 11">
      <path d="M0 0L9 5.5L0 11Z" fill="currentColor" />
    </svg>
  );
}

export function AuthError({ message }: { message: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        background: "rgba(255,80,80,0.1)",
        border: "1px solid rgba(255,80,80,0.3)",
        padding: "12px 16px",
        marginBottom: 20,
        borderRadius: 8,
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ff5050" strokeWidth="2" strokeLinecap="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v4M12 16h.01" />
      </svg>
      <span style={{ fontSize: 13, color: "#ff9090" }}>{message}</span>
    </div>
  );
}

/** Floating white logo tile + title + subtitle above the card. */
export function AuthHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div style={{ textAlign: "center", marginBottom: 28 }}>
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 64,
          height: 64,
          background: "#fff",
          borderRadius: 14,
          boxShadow: "0 0 32px rgba(47,107,255,0.35)",
          overflow: "hidden",
          animation: "paFloat 4s ease-in-out infinite",
        }}
      >
        <Image src="/logo.png" alt="PostAutomation" width={52} height={52} style={{ width: 52, height: 52, display: "block" }} />
      </div>
      <h1
        style={{
          fontFamily: "'Chakra Petch',sans-serif",
          fontWeight: 700,
          fontSize: 22,
          letterSpacing: "0.1em",
          margin: "14px 0 6px",
        }}
      >
        {title}
      </h1>
      <p style={{ fontSize: 14, color: "rgba(205,216,245,0.6)", margin: 0 }}>{subtitle}</p>
    </div>
  );
}
