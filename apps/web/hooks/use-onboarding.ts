import { trpc } from "~/lib/trpc/client";

export function useOnboarding() {
  const { data: progress, isLoading } = trpc.onboarding.getProgress.useQuery(
    undefined,
    {
      retry: false,
      refetchOnWindowFocus: false,
    }
  );

  const isComplete = progress?.isComplete ?? false;
  const skipped = progress?.skippedAt !== null && progress?.skippedAt !== undefined;
  const needsOnboarding = !isLoading && !!progress && !isComplete && !skipped;

  return {
    needsOnboarding,
    isLoading,
    progress: progress ?? null,
  };
}
