"use client";

import { useState } from "react";
import type { Canvas } from "fabric";
import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useToast } from "~/hooks/use-toast";
import { Loader2, Save } from "lucide-react";

interface TemplatePanelProps {
  canvas: Canvas | null;
  canvasJson: () => any;
  loadJson: (json: any) => Promise<void>;
  exportThumbnail: () => string;
  canvasWidth: number;
  canvasHeight: number;
}

const CATEGORIES = [
  "news_card", "quote", "promo", "announcement",
  "before_after", "story", "carousel", "custom",
];

export function TemplatePanel({
  canvas, canvasJson, loadJson, exportThumbnail, canvasWidth, canvasHeight,
}: TemplatePanelProps) {
  const { toast } = useToast();
  const [filterCategory, setFilterCategory] = useState<string>("");
  const [saveName, setSaveName] = useState("");
  const [saveCategory, setSaveCategory] = useState("custom");
  const [showSave, setShowSave] = useState(false);

  const utils = trpc.useUtils();
  const { data: templates, isLoading, refetch } = trpc.designTemplate.list.useQuery(
    filterCategory ? { category: filterCategory } : undefined
  );
  const createTemplate = trpc.designTemplate.create.useMutation({
    onSuccess: () => {
      toast({ title: "Template saved!" });
      setSaveName("");
      setShowSave(false);
      refetch();
    },
    onError: (err) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const handleSave = () => {
    if (!saveName.trim()) return;
    const json = canvasJson();
    const thumbnail = exportThumbnail();
    createTemplate.mutate({
      name: saveName,
      category: saveCategory,
      canvasJson: json,
      thumbnail,
      width: canvasWidth,
      height: canvasHeight,
    });
  };

  const handleLoad = async (templateId: string) => {
    try {
      toast({ title: "Loading template..." });
      const template = await utils.designTemplate.getById.fetch({ id: templateId });
      if (template?.canvasJson) {
        await loadJson(template.canvasJson);
        toast({ title: "Template loaded" });
      }
    } catch {
      toast({ title: "Failed to load template", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold">Templates</h3>

      <select
        value={filterCategory}
        onChange={(e) => setFilterCategory(e.target.value)}
        className="h-8 w-full rounded border bg-background px-2 text-xs"
      >
        <option value="">All Categories</option>
        {CATEGORIES.map((c) => (
          <option key={c} value={c}>{c.replace("_", " ")}</option>
        ))}
      </select>

      {isLoading ? (
        <div className="flex justify-center py-4">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : templates?.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">No templates yet</p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {templates?.map((tmpl: any) => (
            <button
              key={tmpl.id}
              onClick={() => handleLoad(tmpl.id)}
              className="group overflow-hidden rounded-lg border text-left transition-all hover:ring-2 hover:ring-primary"
            >
              <div className="aspect-square overflow-hidden bg-muted">
                {tmpl.thumbnail ? (
                  <img src={tmpl.thumbnail} alt={tmpl.name} className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    No preview
                  </div>
                )}
              </div>
              <div className="p-1.5">
                <p className="truncate text-[10px] font-medium">{tmpl.name}</p>
                <p className="text-[9px] text-muted-foreground">{tmpl.category.replace("_", " ")}</p>
              </div>
            </button>
          ))}
        </div>
      )}

      <div className="border-t pt-3">
        {showSave ? (
          <div className="space-y-2">
            <Input
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="Template name"
              className="h-8 text-xs"
            />
            <select
              value={saveCategory}
              onChange={(e) => setSaveCategory(e.target.value)}
              className="h-8 w-full rounded border bg-background px-2 text-xs"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c.replace("_", " ")}</option>
              ))}
            </select>
            <div className="flex gap-2">
              <Button size="sm" className="flex-1 text-xs" onClick={handleSave} disabled={!saveName.trim() || createTemplate.isPending}>
                {createTemplate.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
              </Button>
              <Button size="sm" variant="ghost" className="text-xs" onClick={() => setShowSave(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" size="sm" className="w-full gap-2 text-xs" onClick={() => setShowSave(true)}>
            <Save className="h-3.5 w-3.5" />
            Save as Template
          </Button>
        )}
      </div>
    </div>
  );
}
