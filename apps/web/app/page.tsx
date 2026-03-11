import Link from "next/link";
import Image from "next/image";

export default function HomePage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      {/* Header */}
      <header className="border-b bg-white/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2">
            <Image src="/logo.png" alt="PostAutomation" width={36} height={36} className="h-9 w-9" />
            <h1 className="text-2xl font-bold text-primary">PostAutomation</h1>
          </Link>
          <div className="flex gap-4">
            <Link
              href="/login"
              className="rounded-md px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
            >
              Sign In
            </Link>
            <Link
              href="/register"
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Get Started
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <main className="mx-auto max-w-7xl px-6 py-24">
        <div className="text-center">
          <h2 className="text-5xl font-bold tracking-tight text-foreground sm:text-6xl">
            AI-Powered Social Media
            <br />
            <span className="text-primary">Scheduling Platform</span>
          </h2>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
            Schedule, automate, and optimize your social media content across 15+
            platforms. Powered by AI for content generation, smart scheduling,
            and analytics.
          </p>
          <div className="mt-10 flex items-center justify-center gap-4">
            <Link
              href="/register"
              className="rounded-lg bg-primary px-8 py-3 text-base font-semibold text-primary-foreground shadow-sm hover:bg-primary/90"
            >
              Start Free Trial
            </Link>
            <Link
              href="#features"
              className="rounded-lg border border-border px-8 py-3 text-base font-semibold text-foreground hover:bg-muted"
            >
              Learn More
            </Link>
          </div>
        </div>

        {/* Features Grid */}
        <div id="features" className="mt-32 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {[
            { title: "15+ Platforms", desc: "Twitter, Instagram, LinkedIn, Facebook, YouTube, TikTok, Reddit, and more." },
            { title: "AI Content Generation", desc: "Generate engaging content with GPT-4 and Claude. Multi-provider AI support." },
            { title: "Smart Scheduling", desc: "Schedule posts at optimal times. BullMQ-powered reliable job processing." },
            { title: "Team Collaboration", desc: "Invite team members with role-based access. Owner, Admin, Member, Viewer roles." },
            { title: "Analytics Dashboard", desc: "Track engagement, reach, and performance across all your social channels." },
            { title: "Media Library", desc: "Upload and manage images and videos. S3-compatible storage with CDN delivery." },
          ].map((feature) => (
            <div key={feature.title} className="rounded-xl border bg-card p-6 shadow-sm">
              <h3 className="text-lg font-semibold text-card-foreground">{feature.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{feature.desc}</p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
