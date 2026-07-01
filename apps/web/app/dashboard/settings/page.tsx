"use client";

import { humanizeError } from "~/lib/errors";

import { trpc } from "~/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Separator } from "~/components/ui/separator";
import { Skeleton } from "~/components/ui/skeleton";
import { Badge } from "~/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useToast } from "~/hooks/use-toast";
import { useState, useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import {
  User, CreditCard, Webhook, Save, Lock,
  Smartphone, CheckCircle2, AlertCircle, Eye, EyeOff, Phone, Camera, Loader2,
  Sparkles, Video, ImageIcon, MessageSquare
} from "lucide-react";
import Link from "next/link";

const COUNTRY_CODES = [
  { code: "+91", label: "+91 India" },
  { code: "+1", label: "+1 US/Canada" },
  { code: "+44", label: "+44 UK" },
  { code: "+61", label: "+61 Australia" },
  { code: "+971", label: "+971 UAE" },
  { code: "+65", label: "+65 Singapore" },
  { code: "+49", label: "+49 Germany" },
  { code: "+33", label: "+33 France" },
  { code: "+880", label: "+880 Bangladesh" },
  { code: "+92", label: "+92 Pakistan" },
];

export default function SettingsPage() {
  const { toast } = useToast();
  const { data: user, isLoading, refetch } = trpc.user.me.useQuery();
  const { data: aiConfig } = trpc.ai.getConfig.useQuery();
  // Fix #94: use session `update()` to sync name change into the NextAuth session
  const { update: updateSession } = useSession();

  // ── Profile ──────────────────────────────────────────────────
  const [name, setName] = useState("");
  const updateProfile = trpc.user.updateProfile.useMutation({
    onSuccess: async (updatedUser) => {
      // Fix #94: reconcile local state + session so navbar reflects the change immediately
      setName(updatedUser.name ?? "");
      await refetch();
      await updateSession?.();
      toast({ title: "Profile updated!" });
    },
    onError: (err) => toast({ title: "Error", description: humanizeError(err), variant: "destructive" }),
  });

  useEffect(() => {
    if (user?.name) setName(user.name);
  }, [user]);

  // ── Avatar upload ─────────────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || uploadingAvatar) return;
    setUploadingAvatar(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/upload/avatar", { method: "POST", body: form });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "" }));
        throw new Error(
          error === "too_large"
            ? "Image is larger than 2 MB."
            : error === "bad_type"
            ? "Only PNG, JPEG, or WebP are supported."
            : "Upload failed. Please try again."
        );
      }
      const { url } = (await res.json()) as { url: string };
      await updateProfile.mutateAsync({ image: url });
      await updateSession?.();
      toast({ title: "Avatar updated" });
    } catch (err) {
      toast({
        title: "Upload failed",
        description: humanizeError(err),
        variant: "destructive",
      });
    } finally {
      setUploadingAvatar(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

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
    onError: (err) => toast({ title: "Error", description: humanizeError(err), variant: "destructive" }),
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
  const [countryCode, setCountryCode] = useState("+91");
  const [localPhone, setLocalPhone] = useState("");
  // Full number submitted to the backend (country code + digits only).
  const newPhone = countryCode + localPhone.replace(/\D/g, "");
  const [phoneOtp, setPhoneOtp] = useState("");
  const [phoneStep, setPhoneStep] = useState<"idle" | "verify">("idle");
  // Fix #95: phone removal OTP re-challenge state
  const [showRemoveDialog, setShowRemoveDialog] = useState(false);
  const [removeOtp, setRemoveOtp] = useState("");

  const addPhone = trpc.user.addPhone.useMutation({
    onSuccess: () => {
      toast({ title: "OTP sent!", description: "Enter the 6-digit code sent to your phone." });
      setPhoneStep("verify");
    },
    onError: (err) => toast({ title: "Error", description: humanizeError(err), variant: "destructive" }),
  });

  const verifyPhone = trpc.user.verifyPhone.useMutation({
    onSuccess: () => {
      toast({ title: "Phone verified!", description: "You can now use it to log in." });
      setPhoneStep("idle"); setLocalPhone(""); setPhoneOtp("");
      refetch();
    },
    onError: (err) => toast({ title: "Error", description: humanizeError(err), variant: "destructive" }),
  });

  const removePhone = trpc.user.removePhone.useMutation({
    onSuccess: () => {
      toast({ title: "Phone number removed" });
      setShowRemoveDialog(false);
      setRemoveOtp("");
      refetch();
    },
    onError: (err) => toast({ title: "Error", description: humanizeError(err), variant: "destructive" }),
  });

  // Fix #95: send OTP to the phone being removed, then show the dialog
  const requestRemovePhone = trpc.user.addPhone.useMutation({
    onSuccess: () => {
      setShowRemoveDialog(true);
    },
    onError: (err) => toast({ title: "Error", description: humanizeError(err), variant: "destructive" }),
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
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="group relative rounded-full"
                  disabled={uploadingAvatar}
                  aria-label="Change avatar"
                >
                  <Avatar className="h-16 w-16">
                    <AvatarImage src={user?.image || undefined} />
                    <AvatarFallback className="text-lg">{initials}</AvatarFallback>
                  </Avatar>
                  <span className="pointer-events-none absolute inset-0 hidden items-center justify-center rounded-full bg-black/55 text-xs text-white group-hover:flex">
                    {uploadingAvatar ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : (
                      <Camera className="h-5 w-5" />
                    )}
                  </span>
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  hidden
                  onChange={handleAvatarChange}
                />
                <div>
                  <p className="font-medium">{user?.name || "No name set"}</p>
                  <p className="text-sm text-muted-foreground">{user?.email}</p>
                  <p className="text-xs text-muted-foreground/70 mt-0.5">
                    Click avatar to change (PNG, JPEG, WebP — max 2 MB)
                  </p>
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
                    <div className="flex gap-2">
                      <Select value={countryCode} onValueChange={setCountryCode}>
                        <SelectTrigger className="w-[120px] shrink-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {COUNTRY_CODES.map((c) => (
                            <SelectItem key={c.code} value={c.code}>
                              {c.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        id="newPhone"
                        type="tel"
                        inputMode="tel"
                        className="min-w-0 flex-1"
                        value={localPhone}
                        onChange={(e) => setLocalPhone(e.target.value)}
                        placeholder="98765 43210"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Select your country code, then enter your number.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => addPhone.mutate({ phone: newPhone })}
                      disabled={addPhone.isPending || !localPhone.trim()}
                    >
                      {addPhone.isPending ? "Sending..." : (
                        <>
                          <Smartphone className="mr-2 h-4 w-4" />
                          Send Verification OTP
                        </>
                      )}
                    </Button>
                    {/* Fix #95: phone removal requires OTP re-confirmation */}
                    {userAny?.phone && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => {
                          // Send OTP to the phone being removed, then show dialog
                          requestRemovePhone.mutate({ phone: userAny.phone });
                        }}
                        disabled={requestRemovePhone.isPending || removePhone.isPending}
                      >
                        {requestRemovePhone.isPending ? "Sending OTP…" : "Remove Number"}
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* ── AI Providers Status ─────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-purple-500" />
            AI Providers
          </CardTitle>
          <CardDescription>
            Read-only status of AI provider API keys configured by your administrator.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Text / Chat */}
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
              <MessageSquare className="h-3.5 w-3.5" />
              Text &amp; Chat
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              {([
                { label: "OpenAI (GPT-4)",       key: "openai"    },
                { label: "Anthropic (Claude)",    key: "anthropic" },
                { label: "Google Gemini 2.5",     key: "gemini"    },
                { label: "Google Gemma 4",        key: "gemma4"    },
                { label: "xAI Grok 3",            key: "grok"      },
                { label: "DeepSeek",              key: "deepseek"  },
              ] as const).map(({ label, key }) => {
                const ok = aiConfig?.[key];
                return (
                  <div key={key} className="flex items-center justify-between rounded-lg border px-3 py-2">
                    <span className="text-sm">{label}</span>
                    {ok === undefined ? (
                      <span className="text-xs text-muted-foreground">…</span>
                    ) : ok ? (
                      <Badge variant="outline" className="text-[10px] border-emerald-300 text-emerald-600 dark:border-emerald-700 dark:text-emerald-400">✓ Active</Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] text-muted-foreground">Not configured</Badge>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Image Generation */}
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
              <ImageIcon className="h-3.5 w-3.5" />
              Image Generation
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              {([
                { label: "Nano Banana (Gemini)",  key: "imageNanoBanana" },
                { label: "DALL-E 3 (OpenAI)",     key: "imageDalle"      },
                { label: "Meta AI (FLUX.1)",       key: "imageMeta"       },
              ] as const).map(({ label, key }) => {
                const ok = aiConfig?.[key];
                return (
                  <div key={key} className="flex items-center justify-between rounded-lg border px-3 py-2">
                    <span className="text-sm">{label}</span>
                    {ok === undefined ? (
                      <span className="text-xs text-muted-foreground">…</span>
                    ) : ok ? (
                      <Badge variant="outline" className="text-[10px] border-emerald-300 text-emerald-600 dark:border-emerald-700 dark:text-emerald-400">✓ Active</Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] text-muted-foreground">Not configured</Badge>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Video Generation */}
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
              <Video className="h-3.5 w-3.5" />
              Video Generation
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {([
                { label: "Veo 3 (Google)",        key: "videoVeo"      },
                { label: "Seedance 2.0 (fal.ai)", key: "videoSeedance" },
              ] as const).map(({ label, key }) => {
                const ok = aiConfig?.[key];
                return (
                  <div key={key} className="flex items-center justify-between rounded-lg border px-3 py-2">
                    <span className="text-sm">{label}</span>
                    {ok === undefined ? (
                      <span className="text-xs text-muted-foreground">…</span>
                    ) : ok ? (
                      <Badge variant="outline" className="text-[10px] border-emerald-300 text-emerald-600 dark:border-emerald-700 dark:text-emerald-400">✓ Active</Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] text-muted-foreground">Not configured</Badge>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <p className="text-xs text-muted-foreground pt-1">
            AI keys are managed server-side by your administrator. Contact them to enable additional providers.
          </p>
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

      {/* Fix #95: OTP confirmation dialog for phone removal */}
      <Dialog open={showRemoveDialog} onOpenChange={(open) => { if (!open) { setShowRemoveDialog(false); setRemoveOtp(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Phone Removal</DialogTitle>
            <DialogDescription>
              We sent a 6-digit OTP to <strong>{(userAny as any)?.phone}</strong>. Enter it below to confirm removal.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 py-2">
            <Label htmlFor="remove-otp">One-Time Code</Label>
            <Input
              id="remove-otp"
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={removeOtp}
              onChange={(e) => setRemoveOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="123456"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setShowRemoveDialog(false); setRemoveOtp(""); }}
              disabled={removePhone.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={removePhone.isPending || removeOtp.length !== 6}
              onClick={() => removePhone.mutate({ otp: removeOtp })}
            >
              {removePhone.isPending ? "Removing…" : "Remove Phone"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
