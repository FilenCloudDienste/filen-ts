import { createFileRoute } from "@tanstack/react-router"
import { DirectoryListing } from "@/features/drive/components/directoryListing"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

// Flat listing, always uuid-less — the worker resolves "recents" straight to listRecents().
export const Route = createFileRoute("/_app/recents")({
	head: routeHead({ title: () => [i18n.t("drive:driveRecents")] }),
	component: RecentsPage
})

function RecentsPage() {
	return (
		<DirectoryListing
			variant="recents"
			splat=""
		/>
	)
}
