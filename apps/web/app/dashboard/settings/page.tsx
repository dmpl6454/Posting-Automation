"use client";

import { trpc } from "~/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Separator } from "~/components/ui/separator";
import { Skeleton } from "~/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { useToast } from "~/hooks/use-toast";
import { useState, useEffect } from "react";
import { Settings, User, CreditCard, Webhook, Save } from "lucide-react";
import Link from "next/link";

export default function SettingsPage() {
  const { toast } = useToast();
  const { data: user, isLoading } = trpc.user.me.useQuery();
  const updateProfile = trpc.user.updateProfile.useMutation({
    onSuccess: () => toast({ title: "Profile updated!" }),
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const [name, setName] = useState("");

  useEffect(() => {
    if (user?.name) setName(user.name);
  }, [user]);

  const initials = (user?.name || "U")
    .split(" ")
    .map((n: string) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Manage your account and preferences</p>
      </div>

      {/* Profile */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <User className="h-5 w-5" />
            Profile
          </CardTitle>
          <CardDescription>Your personal information</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <Skeleton className="h-32" />
          ) : (
            <>
              <div className="flex items-center gap-4">
                <Avatar className="h-16 w-16">
                  <AvatarImage src={user?.image || undefined} />
                  <AvatarFallback className="text-lg">{initials}</AvatarFallback>
                </Avatar>
                <div>
                  <p className="font-medium">{user?.name || "No name set"}</p>
                  <p className="text-sm text-muted-foreground">{user?.email}</p>
                </div>
              </div>
              <Separator />
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="name">Display Name</Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Your name"
                  />
                </div>
                <Button
                  onClick={() => updateProfile.mutate({ name })}
                  disabled={updateProfile.isPending || name === user?.name}
                  size="sm"
                >
                  <Save className="mr-2 h-4 w-4" />
                  Save Changes
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Navigation Cards */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Link href="/dashboard/settings/billing">
          <Card className="cursor-pointer transition-colors hover:bg-muted/50">
            <CardContent className="flex items-center gap-4 p-6">
              <div className="rounded-lg bg-green-100 p-2.5 text-green-600 dark:bg-green-950 dark:text-green-400">
                <CreditCard className="h-5 w-5" />
              </div>
              <div>
                <p className="font-medium">Billing</p>
                <p className="text-xs text-muted-foreground">Manage subscription and payments</p>
              </div>
            </CardContent>
          </Card>
        </Link>
        <Link href="/dashboard/settings/webhooks">
          <Card className="cursor-pointer transition-colors hover:bg-muted/50">
            <CardContent className="flex items-center gap-4 p-6">
              <div className="rounded-lg bg-purple-100 p-2.5 text-purple-600 dark:bg-purple-950 dark:text-purple-400">
                <Webhook className="h-5 w-5" />
              </div>
              <div>
                <p className="font-medium">Webhooks</p>
                <p className="text-xs text-muted-foreground">Configure event notifications</p>
              </div>
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  );
}
