import { createFileRoute } from "@tanstack/react-router"
import { TransfersScreen } from "@/features/transfers/screens/transfers"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

// Flat page, no splat — the full active+finished history and bulk actions the rail popover's "See
// all" links to.
export const Route = createFileRoute("/_app/transfers")({
	head: routeHead({ title: () => [i18n.t("common:moduleTransfers")] }),
	component: TransfersScreen
})
