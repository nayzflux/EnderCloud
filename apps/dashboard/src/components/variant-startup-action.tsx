"use client";

import { useMutation } from "@tanstack/react-query";
import { RotateCcwIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useCluster } from "@/components/cluster-provider";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { retryVariantStartup } from "@/lib/api";

export function VariantStartupAction({
  groupId,
  variantId,
  revision,
}: {
  readonly groupId: string;
  readonly variantId: string;
  readonly revision: number;
}) {
  const { refresh } = useCluster();
  const [open, setOpen] = useState(false);
  const mutation = useMutation({
    mutationFn: () => retryVariantStartup(groupId, variantId, revision),
    onSuccess: () => {
      setOpen(false);
      refresh();
      toast.success("Startup retry reset started.");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Startup retry reset failed.");
    },
  });

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!mutation.isPending) setOpen(nextOpen);
      }}
    >
      <AlertDialogTrigger render={<Button variant="outline" size="xs" />}>
        <RotateCcwIcon data-icon="inline-start" />
        Retry
      </AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogMedia>
            <TriangleAlertIcon />
          </AlertDialogMedia>
          <AlertDialogTitle>Retry {variantId} revision {revision}?</AlertDialogTitle>
          <AlertDialogDescription>
            EnderCloud will remove the retained failed runtime and clear the startup block. The capacity scheduler will decide whether a replacement is needed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <Button
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? <Spinner data-icon="inline-start" /> : <RotateCcwIcon data-icon="inline-start" />}
            {mutation.isPending ? "Resetting" : "Reset and retry"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
