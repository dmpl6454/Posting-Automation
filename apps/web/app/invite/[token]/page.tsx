"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";
import { useRouter, useParams } from "next/navigation";
import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import Link from "next/link";

export default function InviteAcceptPage() {
  // Next 14: route params for a client component come from useParams() — NOT the
  // Next 15 async `params` prop + `use(params)`, which throws
  // "An unsupported type was passed to use()" here (params is a plain object in 14).
  const params = useParams();
  const token = params.token as string;
  const { data: session, status } = useSession();
  const router = useRouter();

  const { data: invite, isLoading, error } = trpc.team.getInvite.useQuery({ token });
  const acceptMutation = trpc.team.acceptInvite.useMutation({
    onSuccess: (data) => {
      router.push(`/dashboard?joined=${data.organizationId}`);
    },
  });

  // Redirect unauthenticated users to login, preserving the invite token
  useEffect(() => {
    if (status === "unauthenticated") {
      router.push(`/login?invite=${token}`);
    }
  }, [status, token, router]);

  if (status === "loading" || isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-4">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <AlertCircle className="mx-auto mb-2 h-10 w-10 text-destructive" />
            <CardTitle>Invalid Invitation</CardTitle>
            <CardDescription>{error.message}</CardDescription>
          </CardHeader>
          <CardFooter>
            <Link href="/dashboard" className="w-full">
              <Button className="w-full" variant="outline">Go to Dashboard</Button>
            </Link>
          </CardFooter>
        </Card>
      </div>
    );
  }

  if (!invite) return null;

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CheckCircle2 className="mx-auto mb-2 h-10 w-10 text-green-500" />
          <CardTitle>You&apos;re Invited!</CardTitle>
          <CardDescription>
            Join <strong>{invite.organization.name}</strong> as{" "}
            <strong className="capitalize">{invite.role.toLowerCase()}</strong>
          </CardDescription>
        </CardHeader>
        <CardContent className="text-center text-sm text-muted-foreground">
          {session?.user?.email ? (
            <p>
              Accepting as <strong>{session.user.email}</strong>
            </p>
          ) : null}
        </CardContent>
        <CardFooter className="flex flex-col gap-2">
          <Button
            className="w-full"
            onClick={() => acceptMutation.mutate({ token })}
            disabled={acceptMutation.isPending}
          >
            {acceptMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            Accept &amp; Join
          </Button>
          {acceptMutation.error && (
            <p className="text-xs text-destructive">{acceptMutation.error.message}</p>
          )}
          <Link href="/dashboard" className="text-xs text-muted-foreground hover:underline">
            Decline
          </Link>
        </CardFooter>
      </Card>
    </div>
  );
}
