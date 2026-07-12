import { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { FileIcon, FolderIcon } from "lucide-react"
import { formatBytes } from "@filen/utils"
import type { FilenPublicLink } from "@/features/chats/lib/embeds.logic"
import type { ChatLinkResolution } from "@/features/chats/queries/chatMessageLinks"
import { linkedFileIntoDriveItem, type DriveItem } from "@/features/drive/lib/item"
import { DirectoryGlyph, ItemIcon } from "@/features/drive/components/itemIcon"
import { allowedMediaContentType } from "@/features/preview/lib/mediaType"
import { isMediaStreamAvailable } from "@/features/preview/lib/previewStream"
import { usePreviewStreamUrl } from "@/features/preview/hooks/usePreviewStreamUrl"
import { PreviewOverlay } from "@/features/preview/components/previewOverlay"
import { Skeleton } from "@/components/ui/skeleton"
import { noop } from "@/lib/utils"

const CARD_CLASS =
	"mt-1 flex max-w-sm min-w-0 items-center gap-2.5 rounded-xl border border-border bg-muted/40 px-3 py-2 text-sm transition-colors hover:bg-muted/70"

function formatCardDate(timestamp: bigint): string {
	return new Date(Number(timestamp)).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}

// Icon + name + subtitle, either a plain new-tab anchor (`href`) or a click-to-preview button
// (`onClick`) — the one shared shell every FilenLinkCard branch below renders through, so the visual
// treatment (icon/name/subtitle/chrome) stays identical regardless of what the click actually does.
function LinkCardShell({
	icon,
	name,
	subtitle,
	ariaLabel,
	href,
	onClick
}: {
	icon: ReactNode
	name: string
	subtitle: string
	ariaLabel: string
	href?: string
	onClick?: () => void
}) {
	if (href !== undefined) {
		return (
			<a
				href={href}
				target="_blank"
				rel="noopener noreferrer nofollow"
				aria-label={ariaLabel}
				className={CARD_CLASS}
			>
				{icon}
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="truncate font-medium text-foreground">{name}</span>
					<span className="truncate text-xs text-muted-foreground">{subtitle}</span>
				</span>
			</a>
		)
	}

	return (
		<button
			type="button"
			aria-label={ariaLabel}
			onClick={onClick}
			className={CARD_CLASS}
		>
			{icon}
			<span className="flex min-w-0 flex-1 flex-col text-left">
				<span className="truncate font-medium text-foreground">{name}</span>
				<span className="truncate text-xs text-muted-foreground">{subtitle}</span>
			</span>
		</button>
	)
}

// A resolved Filen file link's rich card (pdf/docx/text/code/markdown, and the fallback for a failed
// image/video/audio inline stream below) — click opens the SAME PreviewOverlay every owned drive file
// uses, fed the fabricated linked-file item via its "drive" arm (linkedFileIntoDriveItem, item.ts) —
// zero new viewer code for any of these categories. `variant="links"` (not "drive"): the item is
// neither owned nor a real tree member, so this keeps the overlay's inline-editor save path inert
// (isEditable gates on variant==="drive") on top of previewMenuVisible's own isLinkedEmbedItem check.
function FilenPreviewCard({ item, name, subtitle, icon }: { item: DriveItem; name: string; subtitle: string; icon: ReactNode }) {
	const { t } = useTranslation("chats")
	const [previewOpen, setPreviewOpen] = useState(false)

	return (
		<>
			<LinkCardShell
				icon={icon}
				name={name}
				subtitle={subtitle}
				ariaLabel={t("chatEmbedOpenPreview", { name })}
				onClick={() => {
					setPreviewOpen(true)
				}}
			/>
			{previewOpen ? (
				<PreviewOverlay
					variant="links"
					items={[{ type: "drive", item }]}
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

// Streamed leg of the inline image/video/audio embed — only ever mounted once the caller (FilenInlineMedia)
// has confirmed both a validated content-type AND an active service worker, so this never has to itself
// fall back to a whole-buffer path (unlike imageViewer.tsx/mediaViewer.tsx's own dual-path viewers): a
// registration/stream failure here degrades straight to the rich card instead, which reopens the SAME
// content through the full PreviewOverlay — whose own ImageViewer/MediaViewer already carry that buffered
// fallback, so it isn't reimplemented a second time for this thin inline element.
function FilenStreamedInlineMedia({
	item,
	name,
	category,
	contentType,
	fallback
}: {
	item: DriveItem
	name: string
	category: "image" | "video" | "audio"
	contentType: string
	fallback: ReactNode
}) {
	const { t } = useTranslation("chats")
	const [previewOpen, setPreviewOpen] = useState(false)
	const result = usePreviewStreamUrl(item, name, contentType)

	if (result.status === "pending") {
		return (
			<Skeleton
				className="mt-1 h-40 w-64"
				aria-label={t("chatEmbedLoading")}
			/>
		)
	}

	if (result.status === "error") {
		return <>{fallback}</>
	}

	if (category === "video") {
		return (
			<video
				src={result.url}
				controls
				preload="metadata"
				aria-label={name}
				className="mt-1 max-h-72 max-w-sm rounded-xl border border-border"
			/>
		)
	}

	if (category === "audio") {
		return (
			<audio
				src={result.url}
				controls
				preload="metadata"
				aria-label={name}
				className="mt-1 w-64"
			/>
		)
	}

	// image — click opens the full overlay (zoom/pager chrome), same affordance as MediaEmbed's own
	// external-image branch; video/audio above stay inline-only, native controls cover play/seek/fullscreen.
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
					src={result.url}
					alt={name}
					loading="lazy"
					className="max-h-72 w-auto object-contain"
				/>
			</button>
			{previewOpen ? (
				<PreviewOverlay
					variant="links"
					items={[{ type: "drive", item }]}
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

// Entry point for a previewable-inline category (image/video/audio): renders the rich card fallback
// outright when this browser has no active service worker (or the item's own mime fails the inline
// allowlist, e.g. an unrecognized/spoofed mime) — never attempts a registration this project's own
// streaming path can't serve. mediaType.ts's allowedMediaContentType is the SAME gate imageViewer.tsx/
// mediaViewer.tsx apply before ever considering the streamed route.
function FilenInlineMedia({
	item,
	name,
	category,
	fallback
}: {
	item: DriveItem
	name: string
	category: "image" | "video" | "audio"
	fallback: ReactNode
}) {
	const contentType = allowedMediaContentType(item)

	if (contentType === null || !isMediaStreamAvailable()) {
		return <>{fallback}</>
	}

	return (
		<FilenStreamedInlineMedia
			item={item}
			name={name}
			category={category}
			contentType={contentType}
			fallback={fallback}
		/>
	)
}

// Compact card for a Filen public link (file or directory) pasted into a message — the branch point
// for every resolved category: a previewable image/video/audio gets an inline thumbnail/mini-player, a
// previewable-but-not-inline-rendered file (pdf/docx/text/code/markdown) gets a rich click-to-preview
// card showing its real size, and a non-previewable file OR any directory link opens a new tab
// (target=_blank to the raw link url — a dedicated unauthenticated public-link page isn't shipped yet,
// so this is a deliberate, temporary degrade to today's plain-external-link behavior; only the
// DESTINATION changes once that page ships, not this dispatch). Resolution itself is unchanged — the
// authenticated in-app client, same as the reference mobile client.
//
// `resolution` is undefined while the metadata read is in flight, or when the caller never queried
// (e.g. a test rendering the card in isolation) — either way the card degrades to the bare uuid, never
// blocking on the network read to show SOMETHING.
export function FilenLinkCard({
	url,
	link,
	resolution
}: {
	url: string
	link: FilenPublicLink
	resolution: ChatLinkResolution | undefined
}) {
	const { t } = useTranslation("chats")

	if (resolution?.kind !== "filenLink" || !resolution.success) {
		const Icon = link.kind === "directory" ? FolderIcon : FileIcon

		return (
			<LinkCardShell
				icon={
					<Icon
						aria-hidden="true"
						className="size-5 shrink-0 text-muted-foreground"
					/>
				}
				name={link.linkUuid}
				subtitle={t(link.kind === "directory" ? "chatEmbedFilenDirectory" : "chatEmbedFilenFile")}
				ariaLabel={t("chatEmbedOpenNewTab", { name: link.linkUuid })}
				href={url}
			/>
		)
	}

	const { data } = resolution

	if (data.type === "directory") {
		const name = data.name ?? link.linkUuid

		return (
			<LinkCardShell
				icon={
					<DirectoryGlyph
						color="default"
						className="size-5 shrink-0"
					/>
				}
				name={name}
				subtitle={formatCardDate(data.timestamp)}
				ariaLabel={t("chatEmbedOpenNewTab", { name })}
				href={url}
			/>
		)
	}

	const name = data.name ?? link.linkUuid
	const item = linkedFileIntoDriveItem(data.linkedFile)
	const sizeLabel = formatBytes(Number(data.size))
	const icon = (
		<ItemIcon
			item={item}
			className="size-5 shrink-0"
		/>
	)

	if (data.previewCategory === "image" || data.previewCategory === "video" || data.previewCategory === "audio") {
		return (
			<FilenInlineMedia
				item={item}
				name={name}
				category={data.previewCategory}
				fallback={
					<FilenPreviewCard
						item={item}
						name={name}
						subtitle={sizeLabel}
						icon={icon}
					/>
				}
			/>
		)
	}

	if (data.previewCategory === "other") {
		return (
			<LinkCardShell
				icon={icon}
				name={name}
				subtitle={sizeLabel}
				ariaLabel={t("chatEmbedOpenNewTab", { name })}
				href={url}
			/>
		)
	}

	// pdf | docx | text | code | markdown
	return (
		<FilenPreviewCard
			item={item}
			name={name}
			subtitle={sizeLabel}
			icon={icon}
		/>
	)
}
