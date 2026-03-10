"use client";

import { useState } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "~/components/ui/tabs";
import { TwitterPreview } from "./twitter-preview";
import { LinkedInPreview } from "./linkedin-preview";
import { FacebookPreview } from "./facebook-preview";
import { InstagramPreview } from "./instagram-preview";
import { GenericPreview } from "./generic-preview";
import type { PostPreviewProps } from "./twitter-preview";

type Platform =
  | "twitter"
  | "linkedin"
  | "facebook"
  | "instagram"
  | string;

interface PostPreviewSwitcherProps extends PostPreviewProps {
  platform?: Platform;
  platforms?: Platform[];
}

const PLATFORM_LABELS: Record<string, string> = {
  twitter: "X / Twitter",
  linkedin: "LinkedIn",
  facebook: "Facebook",
  instagram: "Instagram",
};

function getPlatformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] || platform.charAt(0).toUpperCase() + platform.slice(1);
}

function renderPreview(platform: string, props: PostPreviewProps) {
  switch (platform) {
    case "twitter":
      return <TwitterPreview {...props} />;
    case "linkedin":
      return <LinkedInPreview {...props} />;
    case "facebook":
      return <FacebookPreview {...props} />;
    case "instagram":
      return <InstagramPreview {...props} />;
    default:
      return <GenericPreview {...props} platformName={getPlatformLabel(platform)} />;
  }
}

export function PostPreviewSwitcher({
  platform,
  platforms,
  content,
  mediaUrls,
  authorName,
  authorHandle,
  authorAvatar,
  timestamp,
}: PostPreviewSwitcherProps) {
  const previewProps: PostPreviewProps = {
    content,
    mediaUrls,
    authorName,
    authorHandle,
    authorAvatar,
    timestamp,
  };

  const availablePlatforms = platforms ?? (platform ? [platform] : ["twitter", "linkedin", "facebook", "instagram"]);

  const [activePlatform, setActivePlatform] = useState<string>(
    availablePlatforms[0] || "twitter"
  );

  // Single platform - render without tabs
  if (availablePlatforms.length === 1) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-muted-foreground">
            {getPlatformLabel(availablePlatforms[0] ?? "twitter")} Preview
          </span>
        </div>
        {renderPreview(availablePlatforms[0] ?? "twitter", previewProps)}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Tabs value={activePlatform} onValueChange={setActivePlatform}>
        <TabsList className="w-full">
          {availablePlatforms.map((p) => (
            <TabsTrigger key={p} value={p} className="flex-1 text-xs">
              {getPlatformLabel(p)}
            </TabsTrigger>
          ))}
        </TabsList>

        {availablePlatforms.map((p) => (
          <TabsContent key={p} value={p}>
            {renderPreview(p, previewProps)}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
