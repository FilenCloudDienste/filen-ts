import { createFileRoute } from "@tanstack/react-router"
import { DirectoryListing } from "@/features/drive/components/directoryListing"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

// Flat listing, always uuid-less — the worker resolves "trash" straight to listTrash().
export const Route = createFileRoute("/_app/trash")({
	head: routeHead({ title: () => [i18n.t("drive:driveTrash")] }),
	component: TrashPage
})

function TrashPage() {
	return (
		<DirectoryListing
			variant="trash"
			splat=""
		/>
	)
}
