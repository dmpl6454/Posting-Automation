"use client";

import { humanizeError } from "~/lib/errors";

import { trpc } from "~/lib/trpc/client";
import { AccentPicker } from "~/components/layout/accent-picker";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Skeleton } from "~/components/ui/skeleton";
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

/**
 * Design: a section label with the hairline rule running out to the RIGHT of
 * it, not underneath.
 *
 * ⚠️ Deliberately local rather than reusing the shared `.pa-section-head` —
 * that class is also used on the Dashboard, where two of its four call sites
 * put a trailing link ("All", "N events") inside the same row. Turning it into
 * a flex container with an `::after` rule would render label → link → rule
 * there, i.e. the rule in the wrong place on a page already signed off.
 */
function SectionHead({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <span className="text-[10.5px] font-semibold uppercase leading-none tracking-[0.12em] text-faint">
        {children}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** The design's settings card: 14px radius, 22px padding. */
const SETTINGS_CARD = "rounded-[14px] border border-border bg-card p-[22px]";
/** Card header row — a 16px muted glyph beside a 14.5px/600 title. */
const CARD_HEAD = "flex items-center gap-2";
const CARD_TITLE = "text-[14.5px] font-semibold leading-[1.2]";
/** Sub-line, indented past the glyph so it aligns under the title. */
const CARD_SUB = "ml-6 mt-[5px] text-[12px] leading-[1.4] text-muted-foreground";
/** The design's 38px form control. */
const FIELD_38 =
  "h-[38px] rounded-[8px] border-border2 bg-background px-3 text-[12.5px]";
const FIELD_LABEL = "text-[11.5px] font-medium leading-none text-muted-foreground";

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
    <div className="w-full">
      {/* Page header — eyebrow / display title / subtitle (design restyle) */}
      <div>
        <span className="eyebrow">Settings</span>
        <h1 className="display mt-2.5 text-[30px] leading-[1.1]">Settings</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
          Manage your account and preferences
        </p>
      </div>

      {/* Design: each labelled section is its OWN block, so the gap BETWEEN
          sections (28px) is independent of the gap between a section's label
          and its cards (12px). The page used to lay heading and card out as
          flat siblings in one `space-y-6`, which forced both to 24px. */}
      <div className="mt-[26px] flex flex-col gap-7">

      <section>
      <SectionHead>Account</SectionHead>

      {/* ── Profile ─────────────────────────────────────────────── */}
      <div className={SETTINGS_CARD}>
        <div className={CARD_HEAD}>
          <User className="h-4 w-4 text-muted-foreground" />
          <h2 className={CARD_TITLE}>Profile</h2>
        </div>
        <p className={CARD_SUB}>Your personal information</p>
        <div className="mt-4 space-y-4">
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
                  {/* Design: 56px accent-filled circle with dark initials.
                      Follows the accent picker, like every other accent fill. */}
                  <Avatar className="h-14 w-14">
                    <AvatarImage src={user?.image || undefined} />
                    <AvatarFallback className="bg-gold text-[17px] font-bold text-[hsl(var(--gold-foreground))]">
                      {initials}
                    </AvatarFallback>
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
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold leading-[1.3]">
                    {user?.name || "No name set"}
                  </p>
                  <p className="mt-[3px] text-[12px] leading-[1.3] text-muted-foreground">
                    {user?.email}
                  </p>
                  <p className="mt-[3px] text-[10.5px] leading-[1.3] text-faint">
                    Click avatar to change (PNG, JPEG, WebP — max 2 MB)
                  </p>
                </div>
              </div>
              <div className="h-px bg-border" />
              <div className="space-y-3">
                <div className="space-y-[7px]">
                  <Label htmlFor="name" className={FIELD_LABEL}>Display Name</Label>
                  <Input
                    id="name"
                    className={FIELD_38}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Your name"
                  />
                </div>
                <Button
                  onClick={() => updateProfile.mutate({ name })}
                  disabled={updateProfile.isPending || name === user?.name}
                  className="pa-cta-gold h-[34px] gap-1.5 rounded-[8px] px-3.5 text-[12px] font-semibold"
                >
                  <Save className="h-[13px] w-[13px]" />
                  Save Changes
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
      </section>

      <section>
      <SectionHead>Security</SectionHead>

      {/* Design: Password and Mobile Number sit side by side, 1.1fr / 1fr.
          `items-start` so the shorter card doesn't stretch to match. */}
      <div className="grid items-start gap-4 lg:grid-cols-[1.1fr_1fr]">
      {/* ── Change Password ──────────────────────────────────────── */}
      <div className={SETTINGS_CARD}>
        <div className={CARD_HEAD}>
          <Lock className="h-4 w-4 text-muted-foreground" />
          <h2 className={CARD_TITLE}>Password</h2>
        </div>
        <p className={CARD_SUB}>
          {userAny?.hasPassword
            ? "Change your account password"
            : "Set a password to enable email/password login"}
        </p>
        <div className="mt-4 space-y-3">
          {userAny?.hasPassword && (
            <div className="space-y-[7px]">
              <div className="flex items-center justify-between">
                <Label htmlFor="currentPassword" className={FIELD_LABEL}>Current Password</Label>
                <button
                  type="button"
                  onClick={() => setShowPasswords(!showPasswords)}
                  className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  {showPasswords ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                  {showPasswords ? "Hide" : "Show"}
                </button>
              </div>
              <Input
                id="currentPassword"
                className={FIELD_38}
                type={showPasswords ? "text" : "password"}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Enter current password"
              />
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-[7px]">
              <Label htmlFor="newPassword" className={FIELD_LABEL}>New Password</Label>
              <Input
                id="newPassword"
                className={FIELD_38}
                type={showPasswords ? "text" : "password"}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Min. 8 characters"
              />
            </div>
            <div className="space-y-[7px]">
              <Label htmlFor="confirmPassword" className={FIELD_LABEL}>Confirm Password</Label>
              <Input
                id="confirmPassword"
                className={FIELD_38}
                type={showPasswords ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Repeat new password"
              />
            </div>
          </div>
          {newPassword && confirmPassword && newPassword !== confirmPassword && (
            <div className="flex items-center gap-2 text-[12px] text-[#d9695f]">
              <AlertCircle className="h-3.5 w-3.5" />
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
            className="pa-cta-gold mt-1 h-[34px] gap-1.5 self-start rounded-[8px] px-3.5 text-[12px] font-semibold"
          >
            {changePassword.isPending ? "Updating..." : (
              <>
                <Lock className="h-[13px] w-[13px]" />
                {userAny?.hasPassword ? "Update Password" : "Set Password"}
              </>
            )}
          </Button>
        </div>
      </div>

      {/* ── Phone / OTP Login ────────────────────────────────────── */}
      <div className={SETTINGS_CARD}>
        <div className={CARD_HEAD}>
          <Smartphone className="h-4 w-4 text-muted-foreground" />
          <h2 className={CARD_TITLE}>Mobile Number</h2>
        </div>
        <p className={CARD_SUB}>Link your mobile number to enable OTP-based login</p>
        <div className="mt-4 space-y-4">
          {isLoading ? (
            <Skeleton className="h-16" />
          ) : (
            <>
              {/* Current verified phone */}
              {userAny?.phone && (
                /* Literal hex: this project's Tailwind config flattens the
                   green/yellow scales, so a named shade would render the pill's
                   label the same colour as its own background. */
                <div className="flex items-center justify-between rounded-[10px] border border-border2 bg-surface1 px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <Phone className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-[12.5px] font-medium leading-none">{userAny.phone}</span>
                  </div>
                  {userAny?.phoneVerified ? (
                    <span className="inline-flex items-center gap-[5px] rounded-full border border-[rgba(92,184,92,0.3)] bg-[rgba(92,184,92,0.15)] px-[9px] py-[3px] text-[10.5px] font-semibold leading-[1.5] text-[#5cb85c]">
                      <CheckCircle2 className="h-2.5 w-2.5" />
                      Verified
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded-full border border-[rgba(224,184,74,0.3)] bg-[rgba(224,184,74,0.15)] px-[9px] py-[3px] text-[10.5px] font-semibold leading-[1.5] text-[#e0b84a]">
                      Unverified
                    </span>
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
                        <SelectTrigger className="w-[120px] shrink-0" aria-label="Country code">
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
        </div>
      </div>
      </div>
      </section>

      <section>
      <SectionHead>AI &amp; appearance</SectionHead>

      <div className="flex flex-col gap-4">
      {/* ── AI Providers Status ─────────────────────────────────── */}
      <div className={SETTINGS_CARD}>
        <div className={CARD_HEAD}>
          <Sparkles className="h-4 w-4 text-gold" />
          <h2 className={CARD_TITLE}>AI Providers</h2>
        </div>
        <p className={CARD_SUB}>
          Read-only status of AI provider API keys configured by your administrator
        </p>
        <div className="mt-[18px] space-y-4">
          {/* Text / Chat */}
          <div>
            <div className="mb-[9px] flex items-center gap-1.5 text-[10px] font-semibold uppercase leading-none tracking-[0.08em] text-muted-foreground">
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
                  <div key={key} className="flex items-center justify-between gap-2 rounded-[9px] border border-border2 px-3 py-[9px]">
                    <span className="truncate text-[12px] leading-[1.2]">{label}</span>
                    {ok === undefined ? (
                      <span className="text-[11px] text-muted-foreground">…</span>
                    ) : ok ? (
                      <span className="shrink-0 rounded-full bg-[rgba(92,184,92,0.15)] px-[9px] py-0.5 text-[9.5px] font-semibold leading-[1.6] text-[#5cb85c]">Active</span>
                    ) : (
                      <span className="shrink-0 rounded-full bg-tile px-[9px] py-0.5 text-[9.5px] font-semibold leading-[1.6] text-muted-foreground">Not configured</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Image Generation */}
          <div>
            <div className="mb-[9px] flex items-center gap-1.5 text-[10px] font-semibold uppercase leading-none tracking-[0.08em] text-muted-foreground">
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
                  <div key={key} className="flex items-center justify-between gap-2 rounded-[9px] border border-border2 px-3 py-[9px]">
                    <span className="truncate text-[12px] leading-[1.2]">{label}</span>
                    {ok === undefined ? (
                      <span className="text-[11px] text-muted-foreground">…</span>
                    ) : ok ? (
                      <span className="shrink-0 rounded-full bg-[rgba(92,184,92,0.15)] px-[9px] py-0.5 text-[9.5px] font-semibold leading-[1.6] text-[#5cb85c]">Active</span>
                    ) : (
                      <span className="shrink-0 rounded-full bg-tile px-[9px] py-0.5 text-[9.5px] font-semibold leading-[1.6] text-muted-foreground">Not configured</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Video Generation */}
          <div>
            <div className="mb-[9px] flex items-center gap-1.5 text-[10px] font-semibold uppercase leading-none tracking-[0.08em] text-muted-foreground">
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
                  <div key={key} className="flex items-center justify-between gap-2 rounded-[9px] border border-border2 px-3 py-[9px]">
                    <span className="truncate text-[12px] leading-[1.2]">{label}</span>
                    {ok === undefined ? (
                      <span className="text-[11px] text-muted-foreground">…</span>
                    ) : ok ? (
                      <span className="shrink-0 rounded-full bg-[rgba(92,184,92,0.15)] px-[9px] py-0.5 text-[9.5px] font-semibold leading-[1.6] text-[#5cb85c]">Active</span>
                    ) : (
                      <span className="shrink-0 rounded-full bg-tile px-[9px] py-0.5 text-[9.5px] font-semibold leading-[1.6] text-muted-foreground">Not configured</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

        </div>
        <p className="mt-4 text-[11.5px] leading-[1.5] text-faint">
          AI keys are managed server-side by your administrator. Contact them to enable additional providers.
        </p>
      </div>

      {/* ── Accent Color ─────────────────────────────────────────── */}
      <AccentPicker />
      </div>
      </section>

      <section>
      <SectionHead>Billing &amp; integrations</SectionHead>

      {/* ── Navigation Cards ─────────────────────────────────────── */}
      {/* Design: 38px tinted icon tile + title over description. The Billing
          tile keeps its own green (it is a status colour, not the accent); the
          Webhooks tile follows the accent, so it moves with the picker above. */}
      <div className="grid gap-3.5 sm:grid-cols-2">
        <Link
          href="/dashboard/settings/billing"
          className="flex items-center gap-3.5 rounded-[14px] border border-border bg-card p-5 transition-colors hover:bg-hover"
        >
          <div className="flex h-[38px] w-[38px] flex-none items-center justify-center rounded-[10px] bg-[rgba(92,184,92,0.15)] text-[#5cb85c]">
            <CreditCard className="h-[17px] w-[17px]" />
          </div>
          <div className="min-w-0">
            <p className="text-[13px] font-medium leading-[1.3]">Billing</p>
            <p className="mt-[3px] text-[11px] leading-[1.3] text-muted-foreground">
              Manage subscription and payments
            </p>
          </div>
        </Link>
        <Link
          href="/dashboard/settings/webhooks"
          className="flex items-center gap-3.5 rounded-[14px] border border-border bg-card p-5 transition-colors hover:bg-hover"
        >
          <div className="flex h-[38px] w-[38px] flex-none items-center justify-center rounded-[10px] bg-gold/[0.12] text-gold">
            <Webhook className="h-[17px] w-[17px]" />
          </div>
          <div className="min-w-0">
            <p className="text-[13px] font-medium leading-[1.3]">Webhooks</p>
            <p className="mt-[3px] text-[11px] leading-[1.3] text-muted-foreground">
              Configure event notifications
            </p>
          </div>
        </Link>
      </div>
      </section>

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
