import { useSyncExternalStore } from "react"
import { pdfAnnouncer } from "@/features/pdf/tools/liveRegion"

// The editor's one polite live region (tools/liveRegion.ts): always mounted with the viewer, its text set by the tools.
export function PdfLiveRegion({ owner }: { owner: object }) {
	const region = pdfAnnouncer(owner)
	const text = useSyncExternalStore(region.subscribe, region.get, region.get)

	return (
		<div
			role="status"
			aria-live="polite"
			className="sr-only"
			data-pdf-live-region=""
		>
			{text}
		</div>
	)
}
