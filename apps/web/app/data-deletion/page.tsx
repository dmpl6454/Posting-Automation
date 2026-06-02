import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Data Deletion - PostAutomation",
  description:
    "How to request deletion of your PostAutomation account and any data obtained from connected Facebook, Instagram, and other social accounts.",
};

export default function DataDeletionPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:px-8">
      <div className="mb-8 flex items-center justify-between">
        <Link href="/" className="text-sm text-blue-600 hover:underline">
          &larr; Back to Home
        </Link>
        <Link href="/" className="flex items-center gap-2">
          <Image src="/logo.png" alt="PostAutomation" width={32} height={32} className="h-8 w-8" />
          <span className="font-bold text-primary">PostAutomation</span>
        </Link>
      </div>

      <h1 className="mb-2 text-3xl font-bold tracking-tight">Data Deletion Instructions</h1>
      <p className="mb-8 text-sm text-gray-500">Last updated: June 2, 2026</p>

      <div className="prose prose-gray max-w-none space-y-6">
        <section>
          <h2 className="text-xl font-semibold">Overview</h2>
          <p className="mt-2 text-gray-700">
            PostAutomation (&quot;we&quot;, &quot;our&quot;, or &quot;us&quot;) lets you connect social
            media accounts &mdash; including Facebook Pages and Instagram Business accounts &mdash; so
            you can schedule and publish posts. When you connect an account, we store the access
            tokens and basic profile information needed to publish on your behalf. We never store your
            social media passwords. This page explains how to remove that data.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold">What you can delete</h2>
          <ul className="mt-2 list-disc space-y-1 pl-6 text-gray-700">
            <li>
              <strong>A single connected account:</strong> the stored access token, profile name,
              avatar, and any cached account metadata for that platform.
            </li>
            <li>
              <strong>Your entire PostAutomation account:</strong> all connected channels, posts,
              schedules, uploaded media, and personal profile information.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold">Option 1 &mdash; Disconnect a single account</h2>
          <p className="mt-2 text-gray-700">
            This is the fastest way to remove data tied to one Facebook or Instagram account:
          </p>
          <ol className="mt-2 list-decimal space-y-1 pl-6 text-gray-700">
            <li>
              Sign in at{" "}
              <a
                href="https://postautomation.co.in/dashboard/channels"
                className="text-blue-600 hover:underline"
              >
                postautomation.co.in/dashboard/channels
              </a>
              .
            </li>
            <li>Find the connected Facebook or Instagram channel.</li>
            <li>
              Click <strong>Disconnect</strong>. We immediately delete the stored access token and
              the cached profile information for that channel.
            </li>
          </ol>
        </section>

        <section>
          <h2 className="text-xl font-semibold">Option 2 &mdash; Delete your entire account</h2>
          <ol className="mt-2 list-decimal space-y-1 pl-6 text-gray-700">
            <li>
              Sign in and go to{" "}
              <a
                href="https://postautomation.co.in/dashboard/settings"
                className="text-blue-600 hover:underline"
              >
                Settings
              </a>
              .
            </li>
            <li>
              Use the account deletion option, or email us at the address below requesting full
              deletion.
            </li>
            <li>
              We delete your account, all connected channels and their tokens, posts, schedules, and
              uploaded media.
            </li>
          </ol>
        </section>

        <section>
          <h2 className="text-xl font-semibold">Option 3 &mdash; Email request</h2>
          <p className="mt-2 text-gray-700">
            You can request deletion of your account or any data we obtained from Facebook or
            Instagram by emailing{" "}
            <a href="mailto:support@postautomation.co.in" className="text-blue-600 hover:underline">
              support@postautomation.co.in
            </a>{" "}
            from the email address associated with your account, with the subject line{" "}
            <strong>&quot;Data Deletion Request&quot;</strong>. Please include the connected platform
            (e.g. Facebook or Instagram) and the account name if you want a specific account removed.
            We confirm completion within 30 days, and typically much sooner.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold">Removing access from Facebook / Instagram</h2>
          <p className="mt-2 text-gray-700">
            You can also revoke PostAutomation&apos;s access from Meta&apos;s side at any time. Go to
            your Facebook{" "}
            <a
              href="https://www.facebook.com/settings?tab=business_tools"
              className="text-blue-600 hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              Business Integrations
            </a>{" "}
            settings, select <strong>Post Automation 2</strong>, and choose <strong>Remove</strong>.
            This revokes the tokens we hold; we then delete the corresponding stored data.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold">Contact</h2>
          <p className="mt-2 text-gray-700">
            Questions about data deletion? Contact us at{" "}
            <a href="mailto:support@postautomation.co.in" className="text-blue-600 hover:underline">
              support@postautomation.co.in
            </a>
            . See also our{" "}
            <Link href="/privacy" className="text-blue-600 hover:underline">
              Privacy Policy
            </Link>
            .
          </p>
        </section>
      </div>
    </div>
  );
}