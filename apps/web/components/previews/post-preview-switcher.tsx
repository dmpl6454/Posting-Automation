"use client";

import { useState } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "~/components/ui/tabs";
import { TwitterPreview } from "./twitter-preview";
import { LinkedInPreview } from "./linkedin-preview";
import { FacebookPreview } from "./facebook-preview";
import { InstagramPreview } from "./instagram-preview";
import { YouTubePreview } from "./youtube-preview";
import { GenericPreview } from "./generic-preview";
import type { PostPreviewProps } from "./twitter-preview";

type Platform =
  | "twitter"
  | "linkedin"
  | "facebook"
  | "instagram"
  | "youtube"
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
  youtube: "YouTube",
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
    case "youtube":
      return <YouTubePreview {...props} />;
    default:
      return <GenericPreview {...props} platformName={getPlatformLabel(platform)} />;
  }
}

export function PostPreviewSwitcher({
  platform,
  platforms,
  content,
  mediaUrls,
  mediaKinds,
  authorName,
  authorHandle,
  authorAvatar,
  timestamp,
  videoPosterUrl,
}: PostPreviewSwitcherProps) {
  const previewProps: PostPreviewProps = {
    content,
    mediaUrls,
    mediaKinds,
    authorName,
    authorHandle,
    authorAvatar,
    timestamp,
    videoPosterUrl,
  };

  const availablePlatforms = platforms ?? (platform ? [platform] : ["instagram", "facebook", "twitter", "linkedin", "youtube"]);

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
        {/* ONE line: the pills never wrap. They stay on a single row and the row
            scrolls horizontally if the panel is too narrow for all of them —
            the scrollbar itself is hidden so the bar still reads as a clean
            strip. `flex-none` keeps each pill at its natural width so a long
            label ("X / Twitter") can't be squeezed. */}
        {/* Design: rounded pills — accent fill when active, hairline border
            when not. `bg-transparent` clears the TabsList's own muted bar. */}
        <TabsList className="flex h-auto w-full flex-nowrap justify-start gap-1 overflow-x-auto bg-transparent p-0 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {availablePlatforms.map((p) => (
            <TabsTrigger
              key={p}
              value={p}
              className="flex-none whitespace-nowrap rounded-full border border-border2 px-[11px] py-[7px] text-[11px] font-medium leading-none text-muted-foreground transition-all data-[state=active]:border-gold data-[state=active]:bg-gold data-[state=active]:font-semibold data-[state=active]:text-[hsl(var(--gold-foreground))] data-[state=active]:shadow-none"
            >
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
