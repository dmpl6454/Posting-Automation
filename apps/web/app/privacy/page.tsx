import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy - PostAutomation",
  description: "Privacy Policy for PostAutomation social media scheduling platform.",
};

export default function PrivacyPolicyPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:px-8">
      <div className="mb-8">
        <Link href="/" className="text-sm text-blue-600 hover:underline">
          &larr; Back to Home
        </Link>
      </div>

      <h1 className="mb-2 text-3xl font-bold tracking-tight">Privacy Policy</h1>
      <p className="mb-8 text-sm text-gray-500">Last updated: March 11, 2026</p>

      <div className="prose prose-gray max-w-none space-y-6">
        <section>
          <h2 className="text-xl font-semibold">1. Introduction</h2>
          <p className="mt-2 text-gray-700">
            PostAutomation (&quot;we&quot;, &quot;our&quot;, or &quot;us&quot;) operates the postautomation.co.in
            website and platform. This Privacy Policy explains how we collect, use, disclose, and
            safeguard your information when you use our service.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold">2. Information We Collect</h2>
          <p className="mt-2 text-gray-700">We collect the following types of information:</p>
          <ul className="mt-2 list-disc space-y-1 pl-6 text-gray-700">
            <li>
              <strong>Account Information:</strong> Name, email address, and profile picture when you
              create an account or sign in via Google, GitHub, Facebook, or other OAuth providers.
            </li>
            <li>
              <strong>Social Media Data:</strong> When you connect social media accounts, we access
              tokens and profile information necessary to publish posts on your behalf. We do not
              store your social media passwords.
            </li>
            <li>
              <strong>Content:</strong> Posts, images, and other content you create or upload through
              the platform.
            </li>
            <li>
              <strong>Usage Data:</strong> Browser type, IP address, pages visited, and timestamps
              to improve our services.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold">3. How We Use Your Information</h2>
          <ul className="mt-2 list-disc space-y-1 pl-6 text-gray-700">
            <li>To provide, maintain, and improve our services</li>
            <li>To publish and schedule social media posts on your behalf</li>
            <li>To authenticate your identity and manage your account</li>
            <li>To send important service-related communications</li>
            <li>To detect and prevent fraud or abuse</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold">4. Data Sharing</h2>
          <p className="mt-2 text-gray-700">
            We do not sell your personal information. We may share data with:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-6 text-gray-700">
            <li>
              <strong>Social Media Platforms:</strong> To publish content you have scheduled or
              requested to post.
            </li>
            <li>
              <strong>Service Providers:</strong> Third-party vendors who assist with hosting,
              analytics, and email delivery, bound by confidentiality obligations.
            </li>
            <li>
              <strong>Legal Requirements:</strong> If required by law, court order, or governmental
              authority.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold">5. Data Security</h2>
          <p className="mt-2 text-gray-700">
            We implement industry-standard security measures including encryption in transit (TLS),
            hashed passwords, and secure token storage. However, no method of electronic storage is
            100% secure, and we cannot guarantee absolute security.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold">6. Data Retention</h2>
          <p className="mt-2 text-gray-700">
            We retain your data for as long as your account is active. You may request deletion of
            your account and associated data at any time by contacting us. Social media tokens are
            revoked upon disconnecting a platform.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold">7. Your Rights</h2>
          <p className="mt-2 text-gray-700">You have the right to:</p>
          <ul className="mt-2 list-disc space-y-1 pl-6 text-gray-700">
            <li>Access the personal data we hold about you</li>
            <li>Request correction of inaccurate data</li>
            <li>Request deletion of your data</li>
            <li>Disconnect any connected social media account at any time</li>
            <li>Export your data in a portable format</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold">8. Cookies</h2>
          <p className="mt-2 text-gray-700">
            We use essential cookies for authentication and session management. We do not use
            third-party tracking cookies for advertising purposes.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold">9. Children&apos;s Privacy</h2>
          <p className="mt-2 text-gray-700">
            Our service is not intended for individuals under 13 years of age. We do not knowingly
            collect data from children.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold">10. Changes to This Policy</h2>
          <p className="mt-2 text-gray-700">
            We may update this Privacy Policy from time to time. We will notify you of any material
            changes by posting the new policy on this page with an updated revision date.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold">11. Contact Us</h2>
          <p className="mt-2 text-gray-700">
            If you have questions about this Privacy Policy, please contact us at{" "}
            <a href="mailto:support@postautomation.co.in" className="text-blue-600 hover:underline">
              support@postautomation.co.in
            </a>
            .
          </p>
        </section>
      </div>
    </div>
  );
}
