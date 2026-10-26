import { createFileRoute } from "@tanstack/react-router"
import { SyncPlaceholder } from "@/features/sync/components/syncPlaceholder"

// The bare /sync index, under the sync layout's desktop guard: the select prompt beside the pair list,
// which carries the empty state when there are no pairs.
export const Route = createFileRoute("/_app/sync/")({ component: SyncPlaceholder })
