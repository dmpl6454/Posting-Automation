"use client";

import { useRef, useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useToast } from "~/hooks/use-toast";
import {
  Upload,
  Trash2,
  Loader2,
  ImageIcon,
  ArrowLeft,
} from "lucide-react";
import Link from "next/link";

export default function LogoLibraryPage() {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);

  const { data: logos, isLoading, refetch } = trpc.newsgrid.getLogos.useQuery();
  const { data: channels } = trpc.newsgrid.channelsWithProfiles.useQuery();
  const assignLogo = trpc.newsgrid.assignLogoToChannel.useMutation({
    onSuccess: () => {
      refetch();
      toast({ title: "Logo assigned to channel" });
    },
    onError: (err) => {
      toast({ title: "Failed to assign logo", description: err.message, variant: "destructive" });
    },
  });
  const deleteLogo = trpc.newsgrid.deleteLogo.useMutation({
    onSuccess: () => {
      refetch();
      toast({ title: "Logo deleted" });
    },
    onError: (err) => {
      toast({ title: "Failed to delete logo", description: err.message, variant: "destructive" });
    },
  });

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    setIsUploading(true);
    for (const file of Array.from(files)) {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("category", "logo");
      try {
        const res = await fetch("/api/upload", { method: "POST", body: formData });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Upload failed" }));
          toast({ title: "Upload failed", description: err.error, variant: "destructive" });
        } else {
          toast({ title: `Uploaded ${file.name}` });
        }
      } catch {
        toast({ title: "Upload failed", variant: "destructive" });
      }
    }
    setIsUploading(false);
    refetch();
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const channelNameById = (id: string | null) => {
    if (!id || !channels) return null;
    const ch = channels.find((c: any) => c.id === id);
    return ch?.name ?? null;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/dashboard/newsgrid">
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Logo Library</h1>
            <p className="text-muted-foreground text-sm">
              Upload channel logos for branded news creatives
            </p>
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept="image/*"
          multiple
          onChange={handleUpload}
        />
        <Button onClick={() => fileInputRef.current?.click()} disabled={isUploading}>
          {isUploading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Upload className="mr-2 h-4 w-4" />
          )}
          {isUploading ? "Uploading..." : "Upload Logo"}
        </Button>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="aspect-square rounded-xl" />
          ))}
        </div>
      ) : !logos || logos.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16">
            <ImageIcon className="h-12 w-12 text-muted-foreground/30" />
            <h3 className="mt-4 text-lg font-medium">No logos uploaded yet</h3>
            <p className="mt-1 text-center text-sm text-muted-foreground max-w-sm">
              Upload your channel logos to create branded news creatives.
            </p>
            <Button
              variant="outline"
              className="mt-4"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="mr-2 h-4 w-4" />
              Upload Logo
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {logos.map((logo: any) => {
            const assignedChannel = channelNameById(logo.channelId);
            return (
              <Card key={logo.id} className="group overflow-hidden">
                <div className="relative aspect-square w-full overflow-hidden bg-muted flex items-center justify-center p-4">
                  <img
                    src={logo.url}
                    alt={logo.fileName}
                    className="max-h-full max-w-full object-contain"
                  />
                </div>
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium truncate" title={logo.fileName}>
                      {logo.fileName}
                    </p>
                    {assignedChannel && (
                      <Badge variant="secondary" className="shrink-0 ml-2 text-xs">
                        {assignedChannel}
                      </Badge>
                    )}
                  </div>

                  {/* Assign to channel */}
                  <Select
                    value={logo.channelId ?? ""}
                    onValueChange={(channelId) => {
                      if (channelId) {
                        assignLogo.mutate({ mediaId: logo.id, channelId });
                      }
                    }}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="Assign to channel..." />
                    </SelectTrigger>
                    <SelectContent>
                      {channels?.map((ch: any) => (
                        <SelectItem key={ch.id} value={ch.id}>
                          {ch.name} ({ch.platform})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {/* Delete */}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => deleteLogo.mutate({ mediaId: logo.id })}
                    disabled={deleteLogo.isPending}
                  >
                    <Trash2 className="mr-2 h-3.5 w-3.5" />
                    Delete
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
