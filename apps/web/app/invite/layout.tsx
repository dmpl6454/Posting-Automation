import { Providers } from "~/components/layout/providers";

// The invite-accept page is a client component that uses useSession() and
// trpc.*.useQuery(). Those hooks require SessionProvider + TRPCProvider in the
// layout chain. The root layout (app/layout.tsx) does NOT mount <Providers>
// (only the dashboard/admin/(auth) segment layouts do), so /invite — a
// top-level route outside those segments — rendered with no provider context
// and threw at SSR → HTTP 500 for any token. Mounting <Providers> here mirrors
// the (auth)/layout.tsx pattern and fixes it. force-dynamic because the page
// is session-dependent.
export const dynamic = "force-dynamic";

export default function InviteLayout({ children }: { children: React.ReactNode }) {
  return <Providers>{children}</Providers>;
}
