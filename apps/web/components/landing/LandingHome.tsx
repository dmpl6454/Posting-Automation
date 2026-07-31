"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef } from "react";
import { LANDING_MARKUP } from "./landing-markup";
import { initPAScene, type PASceneControls } from "./pa-scene";

const ACCENT = "#2f6bff";

const GLOBAL_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800;900&family=Chakra+Petch:wght@400;500;600;700&display=swap');
html{scroll-behavior:smooth;}
html,body{background:#060912;margin:0;padding:0;}
@keyframes paBounce{0%,100%{transform:translateY(0)}50%{transform:translateY(5px)}}

/* ---- hero mobile responsiveness (overrides inline styles) ---- */
@media (max-width:860px){
  .pa-nav{padding:13px 16px !important;}
  .pa-nav-links{gap:8px !important;}
  .pa-nav-hide{display:none !important;}
  .pa-nav-links a{padding:9px 14px !important;letter-spacing:0.1em !important;}
  .pa-nav-brand{font-size:12.5px !important;letter-spacing:0.12em !important;}
  .pa-hero-col{width:100% !important;padding:118px 22px 64px !important;}
  .pa-hero-fade{background:linear-gradient(to bottom,rgba(5,7,14,0.8),rgba(5,7,14,0.5)) !important;}
  .pa-stats{gap:16px !important;}
}
@media (max-width:520px){
  .pa-nav-brand{display:none !important;}
  .pa-nav-links a{padding:8px 12px !important;font-size:11px !important;}
  .pa-hero-col{padding-left:18px !important;padding-right:18px !important;}
}

/* ---- content sections mobile responsiveness ---- */
@media (max-width:980px){
  .pa-grid-3{grid-template-columns:repeat(2,1fr) !important;}
  .pa-pricing{grid-template-columns:repeat(2,1fr) !important;}
}
@media (max-width:768px){
  .pa-sec{padding-left:22px !important;padding-right:22px !important;}
  .pa-steps{grid-template-columns:1fr !important;}
  .pa-steps > div{border-right:none !important;border-bottom:1px solid rgba(120,150,230,0.14) !important;padding:26px 0 22px !important;}
  .pa-steps > div:last-child{border-bottom:none !important;}
}
@media (max-width:640px){
  .pa-grid-3{grid-template-columns:1fr !important;}
  .pa-pricing{grid-template-columns:1fr !important;}
  .pa-footer{grid-template-columns:1fr !important;gap:26px !important;}
}
@media (max-width:480px){
  .pa-sec{padding-left:16px !important;padding-right:16px !important;}
}
`;

// three.js r128 + example postprocessing (global THREE.* build, matches the design).
// Vendored under public/landing/vendor (self-hosted — no runtime CDN dependency / CSP risk).
const THREE_SCRIPTS = [
  "/landing/vendor/three.min.js",
  "/landing/vendor/CopyShader.js",
  "/landing/vendor/LuminosityHighPassShader.js",
  "/landing/vendor/EffectComposer.js",
  "/landing/vendor/RenderPass.js",
  "/landing/vendor/ShaderPass.js",
  "/landing/vendor/UnrealBloomPass.js",
];
const SPLASH_SCRIPT = "/landing/splash-cursor.js";

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[data-pa-src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === "1") resolve();
      else {
        existing.addEventListener("load", () => resolve());
        existing.addEventListener("error", () => reject(new Error("load " + src)));
      }
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = false;
    s.dataset.paSrc = src;
    s.addEventListener("load", () => {
      s.dataset.loaded = "1";
      resolve();
    });
    s.addEventListener("error", () => reject(new Error("load " + src)));
    document.head.appendChild(s);
  });
}

export default function LandingHome() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let cancelled = false;

    const timers: ReturnType<typeof setTimeout>[] = [];
    let raf = 0;
    let scene: PASceneControls | null = null;
    let splash: { destroy: () => void; setColor?: (h: string) => void } | null = null;
    const cleanups: (() => void)[] = [];

    // ---------- hover (style-hover attribute) ----------
    root.querySelectorAll<HTMLElement>("[style-hover]").forEach((el) => {
      const base = el.getAttribute("style") || "";
      const hover = el.getAttribute("style-hover") || "";
      const enter = () => {
        el.setAttribute("style", base + ";" + hover);
      };
      const leave = () => {
        el.setAttribute("style", base);
      };
      el.addEventListener("mouseenter", enter);
      el.addEventListener("mouseleave", leave);
      cleanups.push(() => {
        el.removeEventListener("mouseenter", enter);
        el.removeEventListener("mouseleave", leave);
      });
    });

    // ---------- reveal on scroll ----------
    const revealEls = Array.from(root.querySelectorAll<HTMLElement>("[data-reveal]"));
    if (revealEls.length) {
      const idx = new Map<Element, number>();
      revealEls.forEach((el) => {
        const p = el.parentElement as Element;
        const k = idx.get(p) || 0;
        idx.set(p, k + 1);
        el.style.opacity = "0";
        el.style.transform = "translateY(28px)";
        el.style.willChange = "opacity,transform";
        el.style.transition =
          "opacity .8s cubic-bezier(.16,1,.3,1) " + k * 85 + "ms, transform .8s cubic-bezier(.16,1,.3,1) " + k * 85 + "ms";
      });
      const reveal = (el: HTMLElement) => {
        el.style.opacity = "1";
        el.style.transform = "none";
      };
      if ("IntersectionObserver" in window) {
        const io = new IntersectionObserver(
          (ents) => {
            ents.forEach((e) => {
              if (e.isIntersecting) {
                reveal(e.target as HTMLElement);
                io.unobserve(e.target);
              }
            });
          },
          { threshold: 0.1 }
        );
        revealEls.forEach((el) => io.observe(el));
        cleanups.push(() => io.disconnect());
        timers.push(setTimeout(() => revealEls.forEach(reveal), 1800));
      } else {
        revealEls.forEach(reveal);
      }
    }

    // ---------- loader progress + hero reveal ----------
    const pctEl = root.querySelector<HTMLElement>("#pa-pct");
    const labelEl = root.querySelector<HTMLElement>("#pa-loader-label");
    const barEl = root.querySelector<HTMLElement>("#pa-bar");
    const loaderEl = root.querySelector<HTMLElement>("#pa-loader");
    const heroEl = root.querySelector<HTMLElement>("#pa-hero");
    const brandEls = Array.from(root.querySelectorAll<HTMLElement>(".pa-brand"));
    const sqEls = Array.from(root.querySelectorAll<HTMLElement>(".pa-sq"));
    const revEls = Array.from(root.querySelectorAll<HTMLElement>(".pa-rev"));
    const bodyEls = Array.from(root.querySelectorAll<HTMLElement>(".pa-body"));
    const NSQ = 14;

    const paintSquares = (p: number) => {
      const pct = Math.round(p);
      const active = Math.round((p / 100) * (NSQ - 1));
      sqEls.forEach((sq, i) => {
        if (pct >= 100) {
          sq.style.background = "rgba(200,222,255,0.85)";
          sq.style.boxShadow = "0 0 8px " + ACCENT;
        } else if (i === active) {
          sq.style.background = "#ffffff";
          sq.style.boxShadow = "0 0 11px rgba(255,255,255,0.85)";
        } else if (i < active) {
          sq.style.background = "rgba(175,200,255,0.4)";
          sq.style.boxShadow = "none";
        } else {
          sq.style.background = "rgba(150,170,220,0.13)";
          sq.style.boxShadow = "none";
        }
      });
    };

    let finished = false;
    const goReady = () => {
      if (cancelled) return;
      if (loaderEl) {
        loaderEl.style.opacity = "0";
        loaderEl.style.pointerEvents = "none";
      }
      if (heroEl) heroEl.style.opacity = "1";
      revEls.forEach((el) => {
        el.style.transform = "translateY(0)";
        el.style.opacity = "1";
      });
      bodyEls.forEach((el) => {
        el.style.transform = "translateY(0)";
        el.style.opacity = "1";
      });
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      if (pctEl) pctEl.textContent = "100%";
      if (labelEl) labelEl.textContent = "Ready to automate";
      paintSquares(100);
      brandEls.forEach((el) => (el.style.transform = "translateY(0)"));
      if (barEl) barEl.style.opacity = "0";
      timers.push(setTimeout(goReady, 950));
    };

    const dur = 3400;
    const start = performance.now();
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const tick = (now: number) => {
      if (cancelled) return;
      const t = Math.min(1, (now - start) / dur);
      const p = ease(t) * 100;
      if (pctEl) pctEl.textContent = Math.round(p) + "%";
      paintSquares(p);
      if (t < 1) raf = requestAnimationFrame(tick);
      else finish();
    };
    raf = requestAnimationFrame(tick);
    timers.push(setTimeout(finish, dur + 120));

    // ---------- 3D scene + fluid cursor (progressive enhancement) ----------
    let mx = 0;
    let my = 0;
    let cubeHeat = 0;
    const onPointerMove = (e: PointerEvent) => {
      mx = (e.clientX / window.innerWidth) * 2 - 1;
      my = (e.clientY / window.innerHeight) * 2 - 1;
      if (scene) scene.setMouse(mx, my);
    };
    window.addEventListener("pointermove", onPointerMove);
    cleanups.push(() => window.removeEventListener("pointermove", onPointerMove));

    // cursor-proximity: warm the cube + drift splash colour toward violet
    const hex2rgb = (h: string) => {
      h = h.replace("#", "");
      if (h.length === 3) h = h.replace(/./g, (c) => c + c);
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    };
    const rgb2hex = (c: number[]) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
    const from = hex2rgb(ACCENT);
    const to = hex2rgb("#b06bff");
    let curT = -1;
    const onMouseMove = (e: MouseEvent) => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const cx = w * 0.72;
      const cy = h * 0.46;
      const R = Math.min(w, h) * 0.34;
      const d = Math.hypot(e.clientX - cx, e.clientY - cy);
      cubeHeat = Math.max(0, 1 - d / R);
      if (scene) scene.setCubeHeat(cubeHeat);
      const tq = Math.round(Math.max(0, 1 - d / R) * 8) / 8;
      if (tq !== curT && splash && splash.setColor) {
        curT = tq;
        splash.setColor(rgb2hex(from.map((v, i) => v + ((to[i] ?? v) - v) * tq)));
      }
    };
    window.addEventListener("mousemove", onMouseMove);
    cleanups.push(() => window.removeEventListener("mousemove", onMouseMove));

    (async () => {
      try {
        for (const src of THREE_SCRIPTS) {
          await loadScript(src);
          if (cancelled) return;
        }
        scene = initPAScene(ACCENT);
      } catch (e) {
        console.warn("[landing] three scene failed to load", e);
      }
      try {
        await loadScript(SPLASH_SCRIPT);
        if (cancelled) return;
        const fluid = document.getElementById("fluid") as HTMLCanvasElement | null;
        if (fluid && (window as any).initSplashCursor) {
          splash = (window as any).initSplashCursor(fluid, {
            DENSITY_DISSIPATION: 3.5,
            VELOCITY_DISSIPATION: 2,
            PRESSURE: 0.1,
            CURL: 3,
            SPLAT_RADIUS: 0.2,
            SPLAT_FORCE: 6000,
            COLOR_UPDATE_SPEED: 10,
            SHADING: true,
            RAINBOW_MODE: false,
            COLOR: ACCENT,
          });
        }
      } catch (e) {
        console.warn("[landing] splash cursor failed to load", e);
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      timers.forEach(clearTimeout);
      cleanups.forEach((c) => c());
      if (scene) scene.destroy();
      if (splash) {
        try {
          splash.destroy();
        } catch {
          /* noop */
        }
      }
    };
  }, []);

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: GLOBAL_CSS }} />
      <div ref={rootRef} dangerouslySetInnerHTML={{ __html: LANDING_MARKUP }} />
    </>
  );
}
