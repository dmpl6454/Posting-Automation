import LandingHome from "~/components/landing/LandingHome";

// Marketing landing page — implemented from the Claude Design
// "PostAutomation Home.dc.html" (3D ocean/monolith scene, fluid cursor, loader,
// features / how-it-works / pricing / CTA / footer). The full markup is
// server-rendered (see landing-markup.ts) so content stays crawlable; the
// client runtime (LandingHome) drives the loader, scroll reveals, and WebGL.
export default function HomePage() {
  return <LandingHome />;
}
