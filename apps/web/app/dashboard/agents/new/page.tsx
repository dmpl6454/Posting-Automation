"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "~/lib/trpc/client";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { Badge } from "~/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useToast } from "~/hooks/use-toast";
import { Bot, Plus, X, Loader2 } from "lucide-react";

const tones = ["professional", "casual", "humorous", "formal", "inspiring"] as const;
const providers = ["openai", "anthropic", "gemini"] as const;
const frequencies = [
  { label: "Daily", value: "daily", cron: "0 9 * * *" },
  { label: "Weekdays", value: "weekdays", cron: "0 9 * * 1-5" },
  { label: "Weekly", value: "weekly", cron: "0 9 * * 1" },
] as const;

export default function NewAgentPage() {
  const router = useRouter();
  const { toast } = useToast();

  const [name, setName] = useState("");
  const [aiProvider, setAiProvider] = useState<string>("openai");
  const [niche, setNiche] = useState("");
  const [topicInput, setTopicInput] = useState("");
  const [topics, setTopics] = useState<string[]>([]);
  const [tone, setTone] = useState<string>("professional");
  const [customPrompt, setCustomPrompt] = useState("");
  const [frequency, setFrequency] = useState("daily");
  const [postsPerDay, setPostsPerDay] = useState(1);
  const [selectedChannels, setSelectedChannels] = useState<string[]>([]);

  const { data: channels } = trpc.channel.list.useQuery();

  const create = trpc.agent.create.useMutation({
    onSuccess: () => {
      toast({ title: "Agent created", description: "Your AI agent is ready." });
      router.push("/dashboard/agents");
    },
    onError: (err) => {
      toast({
        title: "Failed to create agent",
        description: err.message || "Please try again.",
        variant: "destructive",
      });
    },
  });

  const addTopic = () => {
    const trimmed = topicInput.trim();
    if (trimmed && !topics.includes(trimmed)) {
      setTopics([...topics, trimmed]);
      setTopicInput("");
    }
  };

  const removeTopic = (topic: string) => {
    setTopics(topics.filter((t) => t !== topic));
  };

  const handleTopicKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addTopic();
    }
  };

  const toggleChannel = (channelId: string) => {
    setSelectedChannels((prev) =>
      prev.includes(channelId)
        ? prev.filter((id) => id !== channelId)
        : [...prev, channelId]
    );
  };

  const cronExpression =
    frequencies.find((f) => f.value === frequency)?.cron ?? "0 9 * * *";

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    create.mutate({
      name: name.trim(),
      aiProvider,
      niche: niche.trim(),
      topics,
      tone,
      customPrompt: customPrompt.trim() || undefined,
      cronExpression,
      postsPerRun: postsPerDay,
      channelIds: selectedChannels,
    });
  };

  const platformLabel = (platform: string) => {
    return platform.charAt(0) + platform.slice(1).toLowerCase();
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Create AI Agent</h1>
        <p className="text-muted-foreground">
          Configure an automated agent to generate and post content
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Basic Info */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Bot className="h-5 w-5 text-purple-500" />
              Agent Configuration
            </CardTitle>
            <CardDescription>
              Set up your agent's identity and AI provider
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="name">Agent Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Tech News Bot"
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label>AI Provider</Label>
              <Select value={aiProvider} onValueChange={setAiProvider}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI (GPT-4)</SelectItem>
                  <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
                  <SelectItem value="gemini">Google (Gemini)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="niche">Niche / Industry</Label>
              <Input
                id="niche"
                value={niche}
                onChange={(e) => setNiche(e.target.value)}
                placeholder="e.g., tech startups, fitness, cooking"
              />
            </div>
          </CardContent>
        </Card>

        {/* Content Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Content Settings</CardTitle>
            <CardDescription>
              Define what your agent writes about and how
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Topics */}
            <div className="space-y-1.5">
              <Label>Topics</Label>
              <div className="flex gap-2">
                <Input
                  value={topicInput}
                  onChange={(e) => setTopicInput(e.target.value)}
                  onKeyDown={handleTopicKeyDown}
                  placeholder="Add a topic and press Enter"
                />
                <Button type="button" variant="outline" size="sm" onClick={addTopic} className="shrink-0">
                  <Plus className="h-4 w-4" />
                  Add
                </Button>
              </div>
              {topics.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-2">
                  {topics.map((topic) => (
                    <Badge key={topic} variant="secondary" className="gap-1 pr-1">
                      {topic}
                      <button
                        type="button"
                        onClick={() => removeTopic(topic)}
                        className="ml-0.5 rounded-full p-0.5 hover:bg-muted-foreground/20"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Tone</Label>
              <Select value={tone} onValueChange={setTone}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {tones.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="customPrompt">Custom Prompt (optional)</Label>
              <Textarea
                id="customPrompt"
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                placeholder="Override the default prompt with your own instructions..."
                className="min-h-[100px] resize-none"
              />
            </div>
          </CardContent>
        </Card>

        {/* Schedule Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Schedule</CardTitle>
            <CardDescription>
              Set how often your agent creates content
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Frequency</Label>
                <Select value={frequency} onValueChange={setFrequency}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {frequencies.map((f) => (
                      <SelectItem key={f.value} value={f.value}>
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="postsPerDay">Posts Per Day</Label>
                <Input
                  id="postsPerDay"
                  type="number"
                  min={1}
                  max={10}
                  value={postsPerDay}
                  onChange={(e) => setPostsPerDay(Number(e.target.value))}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Target Channels */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Target Channels</CardTitle>
            <CardDescription>
              Select which connected channels should receive posts
            </CardDescription>
          </CardHeader>
          <CardContent>
            {channels && channels.length > 0 ? (
              <div className="space-y-2">
                {channels.map((channel: any) => (
                  <label
                    key={channel.id}
                    className="flex items-center gap-3 rounded-lg border p-3 cursor-pointer hover:bg-muted/50 transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={selectedChannels.includes(channel.id)}
                      onChange={() => toggleChannel(channel.id)}
                      className="h-4 w-4 rounded border-input accent-primary"
                    />
                    <div className="flex items-center gap-2 flex-1">
                      <span className="text-sm font-medium">
                        {channel.name || channel.platformUsername}
                      </span>
                      <Badge variant="outline" className="text-xs">
                        {platformLabel(channel.platform)}
                      </Badge>
                    </div>
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No connected channels found. Connect a channel first in the
                Channels page.
              </p>
            )}
          </CardContent>
        </Card>

        {/* Submit */}
        <Button
          type="submit"
          className="w-full gap-2"
          disabled={!name.trim() || create.isPending}
        >
          {create.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Bot className="h-4 w-4" />
          )}
          {create.isPending ? "Creating Agent..." : "Create Agent"}
        </Button>
      </form>
    </div>
  );
}
