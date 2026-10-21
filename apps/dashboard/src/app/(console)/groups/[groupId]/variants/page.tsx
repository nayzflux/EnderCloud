import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { VariantExplorer } from "@/components/variants/variant-explorer";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";

export default async function GroupVariantsPage({
  params,
}: {
  readonly params: Promise<{ groupId: string }>;
}) {
  const { groupId } = await params;
  return (
    <>
      <PageHeader
        title={`${groupId} variants`}
        description="How shared server layers resolve into the final variants selected by this group."
        actions={(
          <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/groups" />}>
            <ArrowLeftIcon data-icon="inline-start" />
            Back to groups
          </Button>
        )}
      />
      <VariantExplorer groupId={groupId} />
    </>
  );
}
