import { createFileRoute } from "@tanstack/react-router"
import { SyncPlaceholder } from "@/features/sync/components/syncPlaceholder"

// The bare /sync index, under the sync layout's desktop guard: the select (or add) prompt beside the pair list.
export const Route = createFileRoute("/_app/sync/")({ component: SyncPlaceholder })
