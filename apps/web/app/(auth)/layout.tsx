import Image from "next/image";
import Link from "next/link";
import { Providers } from "~/components/layout/providers";

export const dynamic = "force-dynamic";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100">
        <Link href="/" className="mb-6 flex items-center gap-2">
          <Image src="/logo.png" alt="PostAutomation" width={48} height={48} className="h-12 w-12" />
          <span className="text-2xl font-bold text-primary">PostAutomation</span>
        </Link>
        <div className="w-full max-w-md">{children}</div>
      </div>
    </Providers>
  );
}
