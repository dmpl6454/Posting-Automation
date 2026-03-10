"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { trpc } from "~/lib/trpc/client";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { useToast } from "~/hooks/use-toast";
import {
  Webhook,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Eye,
} from "lucide-react";

type FilterStatus = "all" | "success" | "failure";

export default function WebhookDeliveryPage() {
  const params = useParams();
  const webhookId = params.id as string;
  const { toast } = useToast();

  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<FilterStatus>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const limit = 20;

  // Fetch webhook details
  const { data: webhooks, isLoading: isLoadingWebhook } =
    trpc.webhook.list.useQuery();
  const webhook = webhooks?.find((wh: any) => wh.id === webhookId);

  // Fetch deliveries with pagination and filter
  const successFilter =
    filter === "success" ? true : filter === "failure" ? false : undefined;

  const {
    data: deliveriesData,
    isLoading: isLoadingDeliveries,
    refetch,
  } = trpc.webhookDelivery.list.useQuery({
    webhookId,
    page,
    limit,
    success: successFilter,
  });

  // Fetch full detail when a delivery is expanded
  const { data: expandedDelivery } = trpc.webhookDelivery.get.useQuery(
    { id: expandedId! },
    { enabled: !!expandedId }
  );

  const retryMutation = trpc.webhookDelivery.retry.useMutation({
    onSuccess: () => {
      refetch();
      toast({ title: "Retry queued", description: "The webhook delivery will be retried shortly." });
    },
    onError: (err: any) => {
      toast({
        title: "Retry failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  function handleRetry(deliveryId: string) {
    retryMutation.mutate({ id: deliveryId });
  }

  function toggleExpand(deliveryId: string) {
    setExpandedId(expandedId === deliveryId ? null : deliveryId);
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Back link */}
      <Button variant="ghost" size="sm" asChild>
        <a href="/dashboard/settings/webhooks" className="flex items-center gap-1">
          <ChevronLeft className="h-4 w-4" />
          Back to Webhooks
        </a>
      </Button>

      {/* Webhook Details */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Webhook className="h-5 w-5" />
            Webhook Details
          </CardTitle>
          <CardDescription>Configuration and delivery history</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoadingWebhook ? (
            <div className="space-y-2">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-2/3" />
            </div>
          ) : webhook ? (
            <div className="space-y-3">
              <div>
                <span className="text-sm font-medium text-muted-foreground">URL</span>
                <p className="truncate font-mono text-sm">{webhook.url}</p>
              </div>
              <div>
                <span className="text-sm font-medium text-muted-foreground">Events</span>
                <div className="mt-1 flex flex-wrap gap-1">
                  {webhook.events.map((event: any) => (
                    <Badge key={event} variant="outline" className="text-[10px]">
                      {event}
                    </Badge>
                  ))}
                </div>
              </div>
              <div>
                <span className="text-sm font-medium text-muted-foreground">Status</span>
                <div className="mt-1">
                  <Badge variant={webhook.isActive ? "default" : "secondary"}>
                    {webhook.isActive ? "Active" : "Inactive"}
                  </Badge>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Webhook not found</p>
          )}
        </CardContent>
      </Card>

      {/* Delivery History */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Delivery History</CardTitle>
              <CardDescription>
                {deliveriesData?.total ?? 0} total deliveries
              </CardDescription>
            </div>
            <div className="flex gap-2">
              {(["all", "success", "failure"] as FilterStatus[]).map(
                (f: any) => (
                  <Button
                    key={f}
                    variant={filter === f ? "default" : "outline"}
                    size="sm"
                    onClick={() => {
                      setFilter(f);
                      setPage(1);
                    }}
                  >
                    {f === "all" ? "All" : f === "success" ? "Success" : "Failed"}
                  </Button>
                )
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoadingDeliveries ? (
            <div className="space-y-3 p-6">
              {[1, 2, 3, 4, 5].map((i: any) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : !deliveriesData?.deliveries?.length ? (
            <div className="flex flex-col items-center py-12">
              <Webhook className="h-8 w-8 text-muted-foreground/30" />
              <p className="mt-2 text-sm text-muted-foreground">
                No deliveries found
              </p>
            </div>
          ) : (
            <>
              {/* Table Header */}
              <div className="grid grid-cols-[1fr_100px_80px_140px_100px] gap-4 border-b bg-muted/50 px-6 py-2 text-xs font-medium text-muted-foreground">
                <span>Event</span>
                <span>Status</span>
                <span>Code</span>
                <span>Delivered At</span>
                <span>Actions</span>
              </div>

              {/* Table Rows */}
              <div className="divide-y">
                {deliveriesData.deliveries.map((delivery: any) => (
                  <div key={delivery.id}>
                    <div className="grid grid-cols-[1fr_100px_80px_140px_100px] items-center gap-4 px-6 py-3">
                      <span className="truncate font-mono text-sm">
                        {delivery.event}
                      </span>
                      <span>
                        {delivery.success ? (
                          <Badge
                            variant="default"
                            className="bg-green-500/10 text-green-700 hover:bg-green-500/10"
                          >
                            <CheckCircle2 className="mr-1 h-3 w-3" />
                            OK
                          </Badge>
                        ) : (
                          <Badge
                            variant="destructive"
                            className="bg-red-500/10 text-red-700 hover:bg-red-500/10"
                          >
                            <XCircle className="mr-1 h-3 w-3" />
                            Failed
                          </Badge>
                        )}
                      </span>
                      <span className="font-mono text-sm text-muted-foreground">
                        {delivery.statusCode ?? "-"}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {new Date(delivery.deliveredAt).toLocaleString()}
                      </span>
                      <div className="flex gap-1">
                        {!delivery.success && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            disabled={retryMutation.isPending}
                            onClick={() => handleRetry(delivery.id)}
                            title="Retry delivery"
                          >
                            <RefreshCw className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => toggleExpand(delivery.id)}
                          title="View details"
                        >
                          {expandedId === delivery.id ? (
                            <ChevronUp className="h-3.5 w-3.5" />
                          ) : (
                            <Eye className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </div>
                    </div>

                    {/* Expanded Detail Panel */}
                    {expandedId === delivery.id && (
                      <div className="border-t bg-muted/30 px-6 py-4">
                        {expandedDelivery ? (
                          <div className="space-y-4">
                            <div>
                              <span className="text-xs font-medium text-muted-foreground">
                                Attempts
                              </span>
                              <p className="text-sm">{expandedDelivery.attempts}</p>
                            </div>
                            {expandedDelivery.error && (
                              <div>
                                <span className="text-xs font-medium text-muted-foreground">
                                  Error
                                </span>
                                <pre className="mt-1 max-h-32 overflow-auto rounded bg-destructive/10 p-3 text-xs text-destructive">
                                  {expandedDelivery.error}
                                </pre>
                              </div>
                            )}
                            <div>
                              <span className="text-xs font-medium text-muted-foreground">
                                Payload
                              </span>
                              <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-3 text-xs">
                                {JSON.stringify(expandedDelivery.payload, null, 2)}
                              </pre>
                            </div>
                            {expandedDelivery.response && (
                              <div>
                                <span className="text-xs font-medium text-muted-foreground">
                                  Response
                                </span>
                                <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-3 text-xs">
                                  {expandedDelivery.response}
                                </pre>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <Skeleton className="h-4 w-full" />
                            <Skeleton className="h-4 w-2/3" />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Pagination */}
              {deliveriesData.totalPages > 1 && (
                <div className="flex items-center justify-between border-t px-6 py-3">
                  <span className="text-sm text-muted-foreground">
                    Page {deliveriesData.page} of {deliveriesData.totalPages}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page <= 1}
                      onClick={() => setPage(page - 1)}
                    >
                      <ChevronLeft className="mr-1 h-4 w-4" />
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page >= deliveriesData.totalPages}
                      onClick={() => setPage(page + 1)}
                    >
                      Next
                      <ChevronRight className="ml-1 h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
