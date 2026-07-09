import { createFileRoute } from "@tanstack/react-router"
import { TransfersScreen } from "@/features/transfers/screens/transfers"

// Flat page, no splat — the full active+finished history and bulk actions the rail popover's "See
// all" links to.
export const Route = createFileRoute("/_app/transfers")({ component: TransfersScreen })
