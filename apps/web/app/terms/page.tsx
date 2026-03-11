import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Use - PostAutomation",
  description: "Terms of Use for PostAutomation social media scheduling platform.",
};

export default function TermsOfUsePage() {
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

      <h1 className="mb-2 text-3xl font-bold tracking-tight">Terms of Use</h1>
      <p className="mb-8 text-sm text-gray-500">Last updated: March 11, 2026</p>

      <div className="prose prose-gray max-w-none space-y-6">
        <section>
          <h2 className="text-xl font-semibold">1. Acceptance of Terms</h2>
          <p className="mt-2 text-gray-700">
            By accessing or using PostAutomation (&quot;the Service&quot;), operated at
            postautomation.co.in, you agree to be bound by these Terms of Use. If you do not agree,
            please do not use the Service.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold">2. Description of Service</h2>
          <p className="mt-2 text-gray-700">
            PostAutomation is a social media management platform that allows users to create,
            schedule, and publish content across multiple social media platforms. The Service
            includes AI-powered content generation, post scheduling, analytics, and team
            collaboration features.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold">3. Account Registration</h2>
          <ul className="mt-2 list-disc space-y-1 pl-6 text-gray-700">
            <li>You must provide accurate and complete registration information.</li>
            <li>You are responsible for maintaining the security of your account credentials.</li>
            <li>You must be at least 13 years old to use the Service.</li>
            <li>One person or entity may not maintain more than one account.</li>
            <li>
              You are responsible for all activity that occurs under your account.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold">4. Acceptable Use</h2>
          <p className="mt-2 text-gray-700">You agree not to:</p>
          <ul className="mt-2 list-disc space-y-1 pl-6 text-gray-700">
            <li>Violate any applicable laws or regulations</li>
            <li>Post spam, misleading, or harmful content through the platform</li>
            <li>
              Violate the terms of service of any connected social media platform
            </li>
            <li>Attempt to gain unauthorized access to the Service or its systems</li>
            <li>Use the Service to harass, abuse, or harm others</li>
            <li>Reverse-engineer, decompile, or disassemble the Service</li>
            <li>Use automated means to access the Service beyond the provided API</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold">5. Content Ownership</h2>
          <p className="mt-2 text-gray-700">
            You retain ownership of all content you create and publish through the Service. By using
            the Service, you grant us a limited license to store, process, and transmit your content
            solely for the purpose of operating the Service (e.g., publishing posts to connected
            platforms).
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold">6. AI-Generated Content</h2>
          <p className="mt-2 text-gray-700">
            The Service offers AI-powered content suggestions. You are solely responsible for
            reviewing and approving any AI-generated content before publishing. We do not guarantee
            the accuracy, appropriateness, or originality of AI-generated content.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold">7. Third-Party Platforms</h2>
          <p className="mt-2 text-gray-700">
            The Service integrates with third-party social media platforms. Your use of those
            platforms is subject to their respective terms of service. We are not responsible for
            changes, outages, or policy updates made by third-party platforms that may affect the
            Service.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold">8. Service Availability</h2>
          <p className="mt-2 text-gray-700">
            We strive to maintain high availability but do not guarantee uninterrupted access. We
            may perform scheduled maintenance, and the Service may be temporarily unavailable due to
            factors beyond our control. We are not liable for any loss resulting from service
            interruptions.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold">9. Limitation of Liability</h2>
          <p className="mt-2 text-gray-700">
            To the maximum extent permitted by law, PostAutomation shall not be liable for any
            indirect, incidental, special, consequential, or punitive damages, including loss of
            profits, data, or business opportunities, arising from your use of the Service.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold">10. Termination</h2>
          <p className="mt-2 text-gray-700">
            We reserve the right to suspend or terminate your account if you violate these Terms.
            You may delete your account at any time. Upon termination, your right to use the Service
            ceases immediately, and we may delete your data in accordance with our Privacy Policy.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold">11. Changes to Terms</h2>
          <p className="mt-2 text-gray-700">
            We may update these Terms from time to time. Continued use of the Service after changes
            constitutes acceptance of the updated Terms. We will notify users of material changes
            via email or in-app notification.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold">12. Governing Law</h2>
          <p className="mt-2 text-gray-700">
            These Terms shall be governed by and construed in accordance with the laws of India.
            Any disputes arising from these Terms shall be resolved in the courts of India.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold">13. Contact Us</h2>
          <p className="mt-2 text-gray-700">
            If you have questions about these Terms, please contact us at{" "}
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
