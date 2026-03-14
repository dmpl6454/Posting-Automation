import Link from "next/link";
import Image from "next/image";
import {
  ArrowRight,
  Zap,
  Globe2,
  Sparkles,
  BarChart3,
  Users,
  Shield,
  Calendar,
  ImageIcon,
  Check,
} from "lucide-react";

const features = [
  {
    icon: Globe2,
    title: "15+ Platforms",
    description:
      "Publish to Twitter, Instagram, LinkedIn, Facebook, YouTube, TikTok, Reddit, Pinterest, Threads, and more from one place.",
  },
  {
    icon: Sparkles,
    title: "AI Content Studio",
    description:
      "Generate compelling content with GPT-4, Claude, and Gemini. Repurpose across platforms with a single click.",
  },
  {
    icon: Calendar,
    title: "Smart Scheduling",
    description:
      "Schedule posts at optimal times with our intelligent queue. Bulk schedule, import from CSV, and manage with a visual calendar.",
  },
  {
    icon: Users,
    title: "Team Collaboration",
    description:
      "Invite team members with granular role-based access. Built-in approval workflows keep your brand safe.",
  },
  {
    icon: BarChart3,
    title: "Deep Analytics",
    description:
      "Track engagement, reach, and performance across every channel. Make data-driven decisions with visual reports.",
  },
  {
    icon: ImageIcon,
    title: "AI Image Generation",
    description:
      "Create stunning visuals with Nano Banana 2 and DALL-E. Edit, generate, and attach images directly to posts.",
  },
];

const plans = [
  {
    name: "Starter",
    price: "Free",
    period: "",
    description: "For individuals getting started",
    features: [
      "3 social channels",
      "30 scheduled posts/month",
      "Basic AI generation",
      "Media library (100 MB)",
    ],
    cta: "Get Started",
    href: "/register",
    highlighted: false,
  },
  {
    name: "Pro",
    price: "$20",
    period: "/month",
    description: "For creators and small teams",
    features: [
      "10 social channels",
      "Unlimited scheduled posts",
      "Advanced AI (GPT-4 + Claude)",
      "AI image generation",
      "Team collaboration (3 seats)",
      "Analytics dashboard",
      "CSV import/export",
    ],
    cta: "Start Free Trial",
    href: "/register",
    highlighted: true,
  },
  {
    name: "Business",
    price: "$40",
    period: "/month",
    description: "For growing businesses",
    features: [
      "25 social channels",
      "Unlimited everything",
      "All AI providers",
      "Approval workflows",
      "Team collaboration (10 seats)",
      "Priority support",
      "API access",
      "Custom webhooks",
    ],
    cta: "Start Free Trial",
    href: "/register",
    highlighted: false,
  },
];

const trustedBy = [
  "Content Creators",
  "Marketing Agencies",
  "SaaS Companies",
  "E-commerce Brands",
  "Media Houses",
];

export default function HomePage() {
  return (
    <div className="min-h-screen bg-background">
      {/* Ambient background */}
      <div className="fixed inset-0 mesh-gradient pointer-events-none" aria-hidden="true" />

      {/* Navigation */}
      <header className="sticky top-0 z-50 glass-subtle">
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <Image
              src="/logo.png"
              alt="PostAutomation"
              width={32}
              height={32}
              className="h-8 w-8"
            />
            <span className="text-lg font-semibold tracking-tight">
              PostAutomation
            </span>
          </Link>

          <div className="hidden items-center gap-8 md:flex">
            <Link
              href="#features"
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Features
            </Link>
            <Link
              href="#pricing"
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Pricing
            </Link>
            <Link
              href="/login"
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Sign In
            </Link>
            <Link
              href="/register"
              className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
            >
              Get Started
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>

          {/* Mobile */}
          <div className="flex items-center gap-3 md:hidden">
            <Link
              href="/login"
              className="text-sm font-medium text-muted-foreground"
            >
              Sign In
            </Link>
            <Link
              href="/register"
              className="rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background"
            >
              Get Started
            </Link>
          </div>
        </nav>
      </header>

      {/* Hero */}
      <section className="relative px-6 pb-24 pt-20 sm:pt-32">
        <div className="mx-auto max-w-4xl text-center">
          {/* Badge */}
          <div className="fade-in-up mb-8 inline-flex items-center gap-2 rounded-full border bg-background/80 px-4 py-1.5 text-sm text-muted-foreground backdrop-blur-sm">
            <Zap className="h-3.5 w-3.5 text-amber-500" />
            <span>Powered by AI — GPT-4, Claude & Gemini</span>
          </div>

          <h1 className="fade-in-up fade-in-up-delay-1 text-4xl font-bold tracking-tight sm:text-6xl lg:text-7xl">
            Social media,
            <br />
            <span className="text-gradient">on autopilot.</span>
          </h1>

          <p className="fade-in-up fade-in-up-delay-2 mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground sm:text-xl">
            Create, schedule, and publish content across 15+ platforms.
            Let AI handle the writing while you focus on growing your audience.
          </p>

          <div className="fade-in-up fade-in-up-delay-3 mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <Link
              href="/register"
              className="inline-flex items-center gap-2 rounded-full bg-foreground px-8 py-3.5 text-base font-semibold text-background shadow-premium transition-all hover:opacity-90 hover:shadow-glass-lg"
            >
              Start Free Trial
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="#features"
              className="inline-flex items-center gap-2 rounded-full border px-8 py-3.5 text-base font-medium text-foreground transition-colors hover:bg-secondary"
            >
              See How It Works
            </Link>
          </div>

          {/* Social proof */}
          <div className="fade-in-up fade-in-up-delay-4 mt-16">
            <p className="mb-4 text-xs font-medium uppercase tracking-widest text-muted-foreground/60">
              Trusted by
            </p>
            <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-2">
              {trustedBy.map((name) => (
                <span
                  key={name}
                  className="text-sm font-medium text-muted-foreground/50"
                >
                  {name}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="relative px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <div className="text-center">
            <p className="text-sm font-medium uppercase tracking-widest text-muted-foreground/60">
              Everything you need
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
              One platform, every channel.
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-lg text-muted-foreground">
              Stop switching between tools. PostAutomation brings content creation,
              scheduling, analytics, and collaboration into a single workspace.
            </p>
          </div>

          <div className="mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((feature) => (
              <div
                key={feature.title}
                className="group relative rounded-2xl border bg-card/50 p-6 transition-all duration-300 hover:border-border/80 hover:bg-card hover:shadow-elevated"
              >
                <div className="mb-4 inline-flex rounded-xl bg-secondary p-2.5">
                  <feature.icon className="h-5 w-5 text-foreground/70" />
                </div>
                <h3 className="text-base font-semibold">{feature.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {feature.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section className="relative px-6 py-24">
        <div className="mx-auto max-w-4xl">
          <div className="text-center">
            <p className="text-sm font-medium uppercase tracking-widest text-muted-foreground/60">
              Simple workflow
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
              Three steps to effortless posting.
            </h2>
          </div>

          <div className="mt-16 grid gap-8 sm:grid-cols-3">
            {[
              {
                step: "01",
                title: "Connect",
                desc: "Link your social media accounts in seconds. We support 15+ platforms.",
              },
              {
                step: "02",
                title: "Create",
                desc: "Write content or let AI generate it for you. Attach images, set schedules.",
              },
              {
                step: "03",
                title: "Publish",
                desc: "Posts go live automatically at optimal times. Track performance in real-time.",
              },
            ].map((item) => (
              <div key={item.step} className="text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-foreground text-sm font-bold text-background">
                  {item.step}
                </div>
                <h3 className="text-lg font-semibold">{item.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {item.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="relative px-6 py-24">
        <div className="mx-auto max-w-5xl">
          <div className="text-center">
            <p className="text-sm font-medium uppercase tracking-widest text-muted-foreground/60">
              Pricing
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
              Simple, transparent pricing.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-lg text-muted-foreground">
              Start free. Upgrade as you grow. No hidden fees.
            </p>
          </div>

          <div className="mt-16 grid gap-6 lg:grid-cols-3">
            {plans.map((plan) => (
              <div
                key={plan.name}
                className={`relative rounded-2xl border p-8 transition-all duration-300 ${
                  plan.highlighted
                    ? "border-foreground/20 bg-card shadow-premium scale-[1.02]"
                    : "border-border bg-card/50 hover:border-border/80 hover:bg-card hover:shadow-elevated"
                }`}
              >
                {plan.highlighted && (
                  <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 rounded-full bg-foreground px-4 py-1 text-xs font-medium text-background">
                    Most Popular
                  </div>
                )}
                <div>
                  <h3 className="text-lg font-semibold">{plan.name}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {plan.description}
                  </p>
                  <div className="mt-6 flex items-baseline gap-1">
                    <span className="text-4xl font-bold tracking-tight">
                      {plan.price}
                    </span>
                    {plan.period && (
                      <span className="text-sm text-muted-foreground">
                        {plan.period}
                      </span>
                    )}
                  </div>
                </div>

                <ul className="mt-8 space-y-3">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-3 text-sm">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-foreground/50" />
                      <span className="text-muted-foreground">{f}</span>
                    </li>
                  ))}
                </ul>

                <Link
                  href={plan.href}
                  className={`mt-8 block rounded-full py-3 text-center text-sm font-semibold transition-all ${
                    plan.highlighted
                      ? "bg-foreground text-background hover:opacity-90"
                      : "border bg-secondary text-secondary-foreground hover:bg-secondary/80"
                  }`}
                >
                  {plan.cta}
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="relative px-6 py-24">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Ready to automate your social media?
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-lg text-muted-foreground">
            Join thousands of creators and businesses who use PostAutomation
            to save time and grow their audience.
          </p>
          <div className="mt-10">
            <Link
              href="/register"
              className="inline-flex items-center gap-2 rounded-full bg-foreground px-8 py-3.5 text-base font-semibold text-background transition-all hover:opacity-90 hover:shadow-glass-lg"
            >
              Start Free — No Credit Card Required
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t px-6 py-12">
        <div className="mx-auto max-w-6xl">
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <Link href="/" className="flex items-center gap-2">
                <Image
                  src="/logo.png"
                  alt="PostAutomation"
                  width={28}
                  height={28}
                  className="h-7 w-7"
                />
                <span className="font-semibold tracking-tight">
                  PostAutomation
                </span>
              </Link>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                AI-powered social media scheduling for modern teams and creators.
              </p>
            </div>
            <div>
              <h4 className="text-sm font-semibold">Product</h4>
              <ul className="mt-3 space-y-2">
                <li>
                  <Link href="#features" className="text-sm text-muted-foreground hover:text-foreground">
                    Features
                  </Link>
                </li>
                <li>
                  <Link href="#pricing" className="text-sm text-muted-foreground hover:text-foreground">
                    Pricing
                  </Link>
                </li>
                <li>
                  <Link href="/login" className="text-sm text-muted-foreground hover:text-foreground">
                    Sign In
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <h4 className="text-sm font-semibold">Legal</h4>
              <ul className="mt-3 space-y-2">
                <li>
                  <Link href="/privacy" className="text-sm text-muted-foreground hover:text-foreground">
                    Privacy Policy
                  </Link>
                </li>
                <li>
                  <Link href="/terms" className="text-sm text-muted-foreground hover:text-foreground">
                    Terms of Service
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <h4 className="text-sm font-semibold">Contact</h4>
              <ul className="mt-3 space-y-2">
                <li>
                  <a
                    href="mailto:support@postautomation.co.in"
                    className="text-sm text-muted-foreground hover:text-foreground"
                  >
                    support@postautomation.co.in
                  </a>
                </li>
              </ul>
            </div>
          </div>
          <div className="mt-12 border-t pt-6">
            <p className="text-center text-xs text-muted-foreground/60">
              &copy; {new Date().getFullYear()} PostAutomation. All rights reserved.
            </p>
          </div>
        </div>
      </footer>

      {/* JSON-LD Structured Data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            name: "PostAutomation",
            url: "https://postautomation.co.in",
            description:
              "AI-powered social media scheduling platform for creators and businesses.",
            applicationCategory: "BusinessApplication",
            operatingSystem: "Web",
            offers: [
              {
                "@type": "Offer",
                price: "0",
                priceCurrency: "USD",
                name: "Starter",
              },
              {
                "@type": "Offer",
                price: "20",
                priceCurrency: "USD",
                name: "Pro",
              },
              {
                "@type": "Offer",
                price: "40",
                priceCurrency: "USD",
                name: "Business",
              },
            ],
          }),
        }}
      />
    </div>
  );
}
