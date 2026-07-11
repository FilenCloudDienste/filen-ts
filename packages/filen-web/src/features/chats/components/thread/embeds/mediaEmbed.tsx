import { useState } from "react"
import { useTranslation } from "react-i18next"
import type { DirectMediaCategory } from "@/features/chats/lib/embeds.logic"
import type { ChatLinkResolution } from "@/features/chats/queries/chatMessageLinks"
import { PreviewOverlay } from "@/features/preview/components/previewOverlay"
import { Skeleton } from "@/components/ui/skeleton"
import { noop } from "@/lib/utils"

// Derives a display name from the url's own path — the external preview arm's ONLY handle on the item
// (previewSourceName, previewCategoryForName both key off it), same fallback previewOverlay.tsx itself
// documents for an external source.
function nameFromUrl(url: string): string {
	try {
		const pathname = new URL(url).pathname
		const last = pathname.split("/").pop()

		return last !== undefined && last.length > 0 ? last : url
	} catch {
		return url
	}
}

// Direct image/video embed (D2's "direct image/video" category — never a Filen public link, see
// FilenLinkCard for that). `resolution` undefined = the content-type probe is in flight (skeleton);
// `success: false` = the probe failed (CORS block, timeout, non-matching Content-Type — see
// queries/chatMessageLinks.ts's honest browser SSRF-posture comment) — renders NOTHING, degrading to
// the plain link MessageContent already put inline in the text above. Clicking a successful image opens
// the shared preview overlay's EXTERNAL arm (features/preview/lib/previewSource.ts) — the exact seam
// that arm exists for; video plays inline via native `controls`, no overlay needed.
export function MediaEmbed({
	url,
	category,
	resolution
}: {
	url: string
	category: DirectMediaCategory
	resolution: ChatLinkResolution | undefined
}) {
	const { t } = useTranslation("chats")
	const [previewOpen, setPreviewOpen] = useState(false)

	if (resolution === undefined) {
		return (
			<Skeleton
				className="mt-1 h-40 w-64"
				aria-label={t("chatEmbedLoading")}
			/>
		)
	}

	if (!resolution.success) {
		return null
	}

	const name = nameFromUrl(url)

	if (category === "video") {
		return (
			<video
				src={url}
				controls
				preload="metadata"
				className="mt-1 max-h-72 max-w-sm rounded-xl border border-border"
			/>
		)
	}

	return (
		<>
			<button
				type="button"
				aria-label={t("chatEmbedOpenPreview", { name })}
				onClick={() => {
					setPreviewOpen(true)
				}}
				className="mt-1 block max-w-sm overflow-hidden rounded-xl border border-border"
			>
				<img
					src={url}
					alt={name}
					loading="lazy"
					className="max-h-72 w-auto object-contain"
				/>
			</button>
			{previewOpen ? (
				<PreviewOverlay
					variant="drive"
					items={[{ type: "external", url, name }]}
					index={0}
					onStep={noop}
					onClose={() => {
						setPreviewOpen(false)
					}}
					onItemRemoved={() => {
						setPreviewOpen(false)
					}}
				/>
			) : null}
		</>
	)
}
