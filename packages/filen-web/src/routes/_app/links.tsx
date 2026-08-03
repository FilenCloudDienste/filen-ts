import { createFileRoute } from "@tanstack/react-router"
import { DirectoryListing } from "@/features/drive/components/directoryListing"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

// Flat listing, always uuid-less — the worker resolves "links" straight to listLinkedItems().
export const Route = createFileRoute("/_app/links")({
	head: routeHead({ title: () => [i18n.t("common:driveLinks")] }),
	component: LinksPage
})

function LinksPage() {
	return (
		<DirectoryListing
			variant="links"
			splat=""
		/>
	)
}
