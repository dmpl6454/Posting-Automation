"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { cn } from "~/lib/utils";
import {
  User,
  Building2,
  Share2,
  PenSquare,
  Check,
  ArrowRight,
  SkipForward,
  PartyPopper,
} from "lucide-react";
import Link from "next/link";

const STEPS = [
  {
    key: "profile" as const,
    title: "Complete Your Profile",
    description:
      "Add your name and profile picture so your team knows who you are.",
    icon: User,
    content: ProfileStep,
  },
  {
    key: "organization" as const,
    title: "Create an Organization",
    description:
      "Organizations help you collaborate with your team and manage social accounts together.",
    icon: Building2,
    content: OrganizationStep,
  },
  {
    key: "channel" as const,
    title: "Connect a Channel",
    description:
      "Connect your social media accounts to start scheduling and publishing posts.",
    icon: Share2,
    content: ChannelStep,
  },
  {
    key: "first-post" as const,
    title: "Create Your First Post",
    description:
      "Write your first post and experience the power of AI-assisted content creation.",
    icon: PenSquare,
    content: FirstPostStep,
  },
];

function ProfileStep() {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Head to your profile settings to update your display name and upload an
        avatar image. A complete profile helps your teammates recognize you.
      </p>
      <Button asChild variant="outline">
        <Link href="/dashboard/settings">
          Go to Profile Settings
          <ArrowRight className="ml-2 h-4 w-4" />
        </Link>
      </Button>
    </div>
  );
}

function OrganizationStep() {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Create an organization to group your social channels and collaborate
        with team members. You can set a name and a unique slug for your
        workspace.
      </p>
      <p className="text-xs text-muted-foreground">
        If you already created one during signup, you can mark this step as
        complete.
      </p>
    </div>
  );
}

function ChannelStep() {
  const platforms = [
    { name: "Twitter / X", color: "bg-black dark:bg-white dark:text-black" },
    { name: "Instagram", color: "bg-gradient-to-br from-purple-500 to-pink-500" },
    { name: "Facebook", color: "bg-blue-600" },
    { name: "LinkedIn", color: "bg-blue-700" },
    { name: "YouTube", color: "bg-red-600" },
    { name: "TikTok", color: "bg-black dark:bg-white dark:text-black" },
    { name: "Reddit", color: "bg-orange-600" },
    { name: "Pinterest", color: "bg-red-700" },
  ];

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Connect one or more social media platforms to start publishing content.
      </p>
      <div className="flex flex-wrap gap-2">
        {platforms.map((p) => (
          <span
            key={p.name}
            className={cn(
              "inline-flex items-center rounded-full px-3 py-1 text-xs font-medium text-white",
              p.color
            )}
          >
            {p.name}
          </span>
        ))}
      </div>
      <Button asChild variant="outline">
        <Link href="/dashboard/channels">
          Connect Channels
          <ArrowRight className="ml-2 h-4 w-4" />
        </Link>
      </Button>
    </div>
  );
}

function FirstPostStep() {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Create your first post using our AI-powered editor. Schedule it, preview
        across platforms, and publish when you are ready.
      </p>
      <Button asChild variant="outline">
        <Link href="/dashboard/posts/new">
          Create a Post
          <ArrowRight className="ml-2 h-4 w-4" />
        </Link>
      </Button>
    </div>
  );
}

function CelebrationScreen() {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      {/* CSS-only confetti animation */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        {Array.from({ length: 30 }).map((_, i) => (
          <div
            key={i}
            className="confetti-piece absolute"
            style={{
              left: `${Math.random() * 100}%`,
              animationDelay: `${Math.random() * 3}s`,
              animationDuration: `${2 + Math.random() * 3}s`,
              backgroundColor: [
                "#f87171",
                "#fb923c",
                "#facc15",
                "#4ade80",
                "#60a5fa",
                "#a78bfa",
                "#f472b6",
              ][i % 7],
            }}
          />
        ))}
      </div>

      <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-primary/10">
        <PartyPopper className="h-10 w-10 text-primary" />
      </div>
      <h2 className="mb-2 text-3xl font-bold">You are all set!</h2>
      <p className="mb-8 max-w-md text-muted-foreground">
        You have completed the onboarding process. You are ready to start
        creating and scheduling amazing content across all your social platforms.
      </p>
      <Button asChild size="lg">
        <Link href="/dashboard">
          Go to Dashboard
          <ArrowRight className="ml-2 h-4 w-4" />
        </Link>
      </Button>

      {/* Confetti keyframes injected via style tag */}
      <style>{`
        @keyframes confetti-fall {
          0% {
            transform: translateY(-10vh) rotate(0deg);
            opacity: 1;
          }
          100% {
            transform: translateY(110vh) rotate(720deg);
            opacity: 0;
          }
        }
        .confetti-piece {
          width: 10px;
          height: 10px;
          border-radius: 2px;
          animation: confetti-fall linear infinite;
          top: -10px;
        }
      `}</style>
    </div>
  );
}

export default function OnboardingPage() {
  const router = useRouter();
  const [activeStep, setActiveStep] = useState(0);

  const { data: progress, isLoading } = trpc.onboarding.getProgress.useQuery();
  const utils = trpc.useUtils();

  const completeStepMutation = trpc.onboarding.completeStep.useMutation({
    onSuccess: () => {
      utils.onboarding.getProgress.invalidate();
    },
  });

  const skipMutation = trpc.onboarding.skip.useMutation({
    onSuccess: () => {
      router.push("/dashboard");
    },
  });

  // Determine which steps are completed
  const completedSteps = (progress?.completedSteps ?? []) as string[];
  const allComplete = progress?.isComplete ?? false;

  // Auto-advance to the first incomplete step
  useEffect(() => {
    if (!progress) return;
    const firstIncomplete = STEPS.findIndex(
      (s) => !completedSteps.includes(s.key)
    );
    if (firstIncomplete >= 0) {
      setActiveStep(firstIncomplete);
    }
  }, [progress, completedSteps]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (allComplete) {
    return <CelebrationScreen />;
  }

  const currentStep = STEPS[activeStep]!;
  const StepContent = currentStep.content;
  const isStepCompleted = completedSteps.includes(currentStep.key);
  const completedCount = STEPS.filter((s) =>
    completedSteps.includes(s.key)
  ).length;
  const progressPercent = (completedCount / STEPS.length) * 100;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold sm:text-3xl">
          Welcome to PostAutomation
        </h1>
        <p className="mt-1 text-muted-foreground">
          Complete these steps to get started with your social media automation
          journey.
        </p>
      </div>

      {/* Progress bar */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            {completedCount} of {STEPS.length} steps completed
          </span>
          <button
            onClick={() => skipMutation.mutate()}
            className="flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            disabled={skipMutation.isPending}
          >
            <SkipForward className="h-3.5 w-3.5" />
            Skip onboarding
          </button>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      {/* Step indicators */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {STEPS.map((step, index) => {
          const completed = completedSteps.includes(step.key);
          const isCurrent = index === activeStep;
          const StepIcon = step.icon;

          return (
            <button
              key={step.key}
              onClick={() => setActiveStep(index)}
              className={cn(
                "flex flex-col items-center gap-2 rounded-lg border p-3 text-center transition-all",
                isCurrent && "border-primary bg-primary/5 shadow-sm",
                completed && !isCurrent && "border-green-500/30 bg-green-50 dark:bg-green-950/20",
                !completed && !isCurrent && "border-border hover:border-muted-foreground/30"
              )}
            >
              <div
                className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-full",
                  completed
                    ? "bg-green-100 text-green-600 dark:bg-green-900/40 dark:text-green-400"
                    : isCurrent
                      ? "bg-primary/10 text-primary"
                      : "bg-muted text-muted-foreground"
                )}
              >
                {completed ? (
                  <Check className="h-5 w-5" />
                ) : (
                  <StepIcon className="h-5 w-5" />
                )}
              </div>
              <span className="text-xs font-medium leading-tight">
                {step.title}
              </span>
            </button>
          );
        })}
      </div>

      {/* Active step card */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "flex h-10 w-10 items-center justify-center rounded-full",
                isStepCompleted
                  ? "bg-green-100 text-green-600 dark:bg-green-900/40 dark:text-green-400"
                  : "bg-primary/10 text-primary"
              )}
            >
              {isStepCompleted ? (
                <Check className="h-5 w-5" />
              ) : (
                <currentStep.icon className="h-5 w-5" />
              )}
            </div>
            <div>
              <CardTitle className="text-lg">{currentStep.title}</CardTitle>
              <CardDescription>{currentStep.description}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <StepContent />
        </CardContent>
        <CardFooter className="flex justify-between">
          <Button
            variant="ghost"
            onClick={() => setActiveStep(Math.max(0, activeStep - 1))}
            disabled={activeStep === 0}
          >
            Previous
          </Button>
          <div className="flex gap-2">
            {!isStepCompleted && (
              <Button
                onClick={() => completeStepMutation.mutate({ step: currentStep.key })}
                disabled={completeStepMutation.isPending}
              >
                {completeStepMutation.isPending ? "Saving..." : "Mark Complete"}
                <Check className="ml-2 h-4 w-4" />
              </Button>
            )}
            {activeStep < STEPS.length - 1 && (
              <Button
                variant="outline"
                onClick={() => setActiveStep(activeStep + 1)}
              >
                Next
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            )}
          </div>
        </CardFooter>
      </Card>
    </div>
  );
}
