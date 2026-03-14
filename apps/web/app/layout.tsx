import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fcfcfd" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0f" },
  ],
};

export const metadata: Metadata = {
  title: {
    default: "PostAutomation — AI Social Media Scheduling",
    template: "%s | PostAutomation",
  },
  description:
    "Schedule, automate, and optimize your social media content across 15+ platforms. AI-powered content generation, smart scheduling, and analytics — all in one place.",
  keywords: [
    "social media scheduling",
    "AI content generation",
    "social media automation",
    "post scheduling",
    "social media manager",
    "content calendar",
    "multi-platform posting",
    "social media analytics",
    "Instagram scheduler",
    "Twitter scheduler",
    "LinkedIn scheduler",
  ],
  authors: [{ name: "PostAutomation" }],
  creator: "PostAutomation",
  metadataBase: new URL("https://postautomation.co.in"),
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://postautomation.co.in",
    siteName: "PostAutomation",
    title: "PostAutomation — AI Social Media Scheduling",
    description:
      "Schedule, automate, and optimize your social media content across 15+ platforms with AI.",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "PostAutomation — AI Social Media Scheduling",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "PostAutomation — AI Social Media Scheduling",
    description:
      "Schedule, automate, and optimize your social media content across 15+ platforms with AI.",
    images: ["/og-image.png"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  icons: {
    icon: "/logo.png",
    apple: "/logo.png",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning className={inter.variable}>
      <body className="font-sans">{children}</body>
    </html>
  );
}
