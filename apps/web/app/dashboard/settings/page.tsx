"use client";

import { trpc } from "~/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Separator } from "~/components/ui/separator";
import { Skeleton } from "~/components/ui/skeleton";
import { Badge } from "~/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { useToast } from "~/hooks/use-toast";
import { useState, useEffect } from "react";
import {
  User, CreditCard, Webhook, Save, Lock,
  Smartphone, CheckCircle2, AlertCircle, Eye, EyeOff, Phone
} from "lucide-react";
import Link from "next/link";

export default function SettingsPage() {
  const { toast } = useToast();
  const { data: user, isLoading, refetch } = trpc.user.me.useQuery();

  // ── Profile ──────────────────────────────────────────────────
  const [name, setName] = useState("");
  const updateProfile = trpc.user.updateProfile.useMutation({
    onSuccess: () => { toast({ title: "Profile updated!" }); refetch(); },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  useEffect(() => {
    if (user?.name) setName(user.name);
  }, [user]);

  // ── Change Password ───────────────────────────────────────────
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const changePassword = trpc.user.changePassword.useMutation({
    onSuccess: () => {
      toast({ title: "Password updated!" });
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
    },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const handleChangePassword = () => {
    if (newPassword !== confirmPassword) {
      toast({ title: "Passwords don't match", variant: "destructive" });
      return;
    }
    changePassword.mutate({
      currentPassword: currentPassword || undefined,
      newPassword,
      confirmPassword,
    });
  };

  // ── Phone Number ──────────────────────────────────────────────
  const [newPhone, setNewPhone] = useState("");
  const [phoneOtp, setPhoneOtp] = useState("");
  const [phoneStep, setPhoneStep] = useState<"idle" | "verify">("idle");

  const addPhone = trpc.user.addPhone.useMutation({
    onSuccess: () => {
      toast({ title: "OTP sent!", description: "Enter the 6-digit code sent to your phone." });
      setPhoneStep("verify");
    },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const verifyPhone = trpc.user.verifyPhone.useMutation({
    onSuccess: () => {
      toast({ title: "Phone verified!", description: "You can now use it to log in." });
      setPhoneStep("idle"); setNewPhone(""); setPhoneOtp("");
      refetch();
    },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const removePhone = trpc.user.removePhone.useMutation({
    onSuccess: () => { toast({ title: "Phone number removed" }); refetch(); },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const initials = (user?.name || "U")
    .split(" ")
    .map((n: string) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  const userAny = user as any;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Manage your account and preferences</p>
      </div>

      {/* ── Profile ─────────────────────────────────────────────── */}
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

      {/* ── Change Password ──────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5" />
            Password
          </CardTitle>
          <CardDescription>
            {userAny?.hasPassword
              ? "Change your account password"
              : "Set a password to enable email/password login"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {userAny?.hasPassword && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="currentPassword">Current Password</Label>
                <button
                  type="button"
                  onClick={() => setShowPasswords(!showPasswords)}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  {showPasswords ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  {showPasswords ? "Hide" : "Show"}
                </button>
              </div>
              <Input
                id="currentPassword"
                type={showPasswords ? "text" : "password"}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Enter current password"
              />
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="newPassword">New Password</Label>
              <Input
                id="newPassword"
                type={showPasswords ? "text" : "password"}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Min. 8 characters"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirmPassword">Confirm Password</Label>
              <Input
                id="confirmPassword"
                type={showPasswords ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Repeat new password"
              />
            </div>
          </div>
          {newPassword && confirmPassword && newPassword !== confirmPassword && (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              Passwords do not match
            </div>
          )}
          <Button
            onClick={handleChangePassword}
            disabled={
              changePassword.isPending ||
              !newPassword ||
              !confirmPassword ||
              newPassword !== confirmPassword ||
              newPassword.length < 8
            }
            size="sm"
          >
            {changePassword.isPending ? "Updating..." : (
              <>
                <Lock className="mr-2 h-4 w-4" />
                {userAny?.hasPassword ? "Update Password" : "Set Password"}
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* ── Phone / OTP Login ────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Smartphone className="h-5 w-5" />
            Mobile Number
          </CardTitle>
          <CardDescription>
            Link your mobile number to enable OTP-based login
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <Skeleton className="h-16" />
          ) : (
            <>
              {/* Current verified phone */}
              {userAny?.phone && (
                <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/30 px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Phone className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">{userAny.phone}</span>
                  </div>
                  {userAny?.phoneVerified ? (
                    <Badge variant="outline" className="gap-1 border-green-500/30 bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-400">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Verified
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="border-yellow-500/30 bg-yellow-50 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-400">
                      Unverified
                    </Badge>
                  )}
                </div>
              )}

              {/* OTP verification step */}
              {phoneStep === "verify" ? (
                <div className="space-y-3">
                  <div className="rounded-lg border border-border/40 bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
                    OTP sent to <span className="font-medium text-foreground">{newPhone}</span>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="phoneOtp">Enter 6-digit OTP</Label>
                    <Input
                      id="phoneOtp"
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      value={phoneOtp}
                      onChange={(e) => setPhoneOtp(e.target.value.replace(/\D/g, ""))}
                      placeholder="123456"
                      autoFocus
                      className="text-center text-lg tracking-[0.4em]"
                    />
                    <p className="text-xs text-muted-foreground">Valid for 10 minutes</p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => verifyPhone.mutate({ phone: newPhone, otp: phoneOtp })}
                      disabled={verifyPhone.isPending || phoneOtp.length < 6}
                    >
                      {verifyPhone.isPending ? "Verifying..." : (
                        <>
                          <CheckCircle2 className="mr-2 h-4 w-4" />
                          Verify Number
                        </>
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => { setPhoneStep("idle"); setPhoneOtp(""); }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                /* Add / change phone form */
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="newPhone">
                      {userAny?.phone ? "Change Number" : "Mobile Number"}
                    </Label>
                    <Input
                      id="newPhone"
                      type="tel"
                      value={newPhone}
                      onChange={(e) => setNewPhone(e.target.value)}
                      placeholder="+91 98765 43210"
                    />
                    <p className="text-xs text-muted-foreground">
                      Include country code (e.g. +91 for India, +1 for USA)
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => addPhone.mutate({ phone: newPhone })}
                      disabled={addPhone.isPending || !newPhone}
                    >
                      {addPhone.isPending ? "Sending..." : (
                        <>
                          <Smartphone className="mr-2 h-4 w-4" />
                          Send Verification OTP
                        </>
                      )}
                    </Button>
                    {userAny?.phone && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => removePhone.mutate()}
                        disabled={removePhone.isPending}
                      >
                        Remove Number
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Navigation Cards ─────────────────────────────────────── */}
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
