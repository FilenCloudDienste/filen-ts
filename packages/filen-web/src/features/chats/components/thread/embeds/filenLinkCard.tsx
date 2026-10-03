import { useState, type ReactNode, type SyntheticEvent } from "react"
import { useTranslation } from "react-i18next"
import { FileIcon, FolderIcon } from "lucide-react"
import { formatBytes, type FilenPublicLink } from "@filen/shared"
import type { ChatLinkResolution } from "@/features/chats/queries/chatMessageLinks"
import { asDirectoryOrFile, linkedFileIntoDriveItem, type DriveItem } from "@/features/drive/lib/item"
import { DirectoryGlyph, ItemIcon } from "@/features/drive/components/itemIcon"
import { isStreamedCategory, type StreamedCategory } from "@/features/drive/lib/preview.logic"
import { allowedMediaContentType } from "@/features/preview/lib/mediaType"
import { isMediaStreamAvailable } from "@/features/preview/lib/previewStream"
import { usePreviewStreamUrl } from "@/features/preview/hooks/usePreviewStreamUrl"
import { mediaControlsList } from "@/features/preview/lib/accessMode"
import { PreviewOverlay } from "@/features/preview/components/previewOverlay"
import { LoadingState } from "@/components/loadingState"
import { BlockSource, urlReadRange } from "@/lib/media/blockSource"
import { mediaFailureDTO, reportMediaFailure, type MediaFailureKind } from "@/lib/media/mediaFailure"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { noop } from "@/lib/utils"
import { formatShortDate } from "@/lib/formatDate"
import { EXTERNAL_LINK_REL } from "@/features/chats/components/thread/externalAnchor"

// Cards sit under the bubble on the same neutral surface as other people's bubbles; media sits bare.
const CARD_CLASS =
	"flex max-w-sm min-w-0 items-center gap-2.5 rounded-2xl bg-chat-other px-3 py-2 text-sm focus-ring transition-colors outline-none hover:bg-chat-other-strong"

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
	const body = (
		<>
			{icon}
			<span className="flex min-w-0 flex-1 flex-col text-left">
				<span className="truncate font-medium text-foreground">{name}</span>
				<span className="truncate text-xs text-muted-foreground">{subtitle}</span>
			</span>
		</>
	)

	if (href !== undefined) {
		return (
			<a
				href={href}
				target="_blank"
				rel={EXTERNAL_LINK_REL}
				aria-label={ariaLabel}
				className={CARD_CLASS}
			>
				{body}
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
			{body}
		</button>
	)
}

// The single linked file in the SAME PreviewOverlay every owned drive file uses. `variant="links"` (not
// "drive"): the item is neither owned nor a real tree member, so this keeps the overlay's inline-editor save
// path inert (isEditable gates on variant==="drive") on top of the overlay's own isLinkedEmbedItem menu gate.
function LinkedPreviewOverlay({ item, downloadable, onClose }: { item: DriveItem; downloadable: boolean; onClose: () => void }) {
	return (
		<PreviewOverlay
			variant="links"
			items={[item]}
			index={0}
			onStep={noop}
			onClose={onClose}
			onItemRemoved={onClose}
			downloadable={downloadable}
		/>
	)
}

// A resolved Filen file link's rich card (pdf/docx/text/code/markdown/archive, and the fallback for a failed
// image/video/audio inline stream below) — click opens LinkedPreviewOverlay, fed the fabricated linked-file
// item (linkedFileIntoDriveItem, item.ts) — zero new viewer code for any of these categories. `downloadable`
// is the link's own flag.
function FilenPreviewCard({
	item,
	name,
	subtitle,
	icon,
	downloadable
}: {
	item: DriveItem
	name: string
	subtitle: string
	icon: ReactNode
	downloadable: boolean
}) {
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
				<LinkedPreviewOverlay
					item={item}
					downloadable={downloadable}
					onClose={() => {
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
	downloadable,
	fallback
}: {
	item: DriveItem
	name: string
	category: StreamedCategory
	contentType: string
	downloadable: boolean
	fallback: ReactNode
}) {
	const { t } = useTranslation("chats")
	const [previewOpen, setPreviewOpen] = useState(false)
	const result = usePreviewStreamUrl(item, name, contentType)

	if (result.status === "pending") {
		return (
			<LoadingState
				size="sm"
				className="h-40 w-64 flex-none rounded-2xl bg-chat-other"
			/>
		)
	}

	if (result.status === "error") {
		return <>{fallback}</>
	}

	if (category === "video" || category === "audio") {
		return (
			<FilenInlinePlayer
				key={result.url}
				category={category}
				url={result.url}
				size={Number(asDirectoryOrFile(item).data.size)}
				name={name}
				downloadable={downloadable}
				fallback={fallback}
			/>
		)
	}

	// image — click opens the full overlay (zoom/pager chrome); video/audio above stay inline-only, native
	// controls cover play/seek/fullscreen.
	return (
		<>
			<button
				type="button"
				aria-label={t("chatEmbedOpenPreview", { name })}
				onClick={() => {
					setPreviewOpen(true)
				}}
				className="block max-w-sm overflow-hidden rounded-2xl focus-ring outline-none"
			>
				<img
					src={result.url}
					alt={name}
					loading="lazy"
					className="max-h-72 w-auto object-contain"
				/>
			</button>
			{previewOpen ? (
				<LinkedPreviewOverlay
					item={item}
					downloadable={downloadable}
					onClose={() => {
						setPreviewOpen(false)
					}}
				/>
			) : null}
		</>
	)
}

// The inline video/audio element. A playback failure swaps in the rich card, whose overlay offers the
// file; one the browser cannot decode also says so, where a bare broken player would say nothing.
function FilenInlinePlayer({
	category,
	url,
	size,
	name,
	downloadable,
	fallback
}: {
	category: "video" | "audio"
	url: string
	size: number
	name: string
	downloadable: boolean
	fallback: ReactNode
}) {
	const [source] = useState(() => new BlockSource(size, urlReadRange(url)))
	const [failure, setFailure] = useState<MediaFailureKind | null>(null)

	function handleError(event: SyntheticEvent<HTMLMediaElement>): void {
		reportMediaFailure(event.currentTarget, source, setFailure)
	}

	if (failure === "other") {
		return <>{fallback}</>
	}

	if (failure === "format") {
		return (
			<div className="flex max-w-sm flex-col gap-1">
				{fallback}
				<p className="px-3 text-xs text-destructive">{errorLabel(mediaFailureDTO("format"))}</p>
			</div>
		)
	}

	if (category === "video") {
		return (
			<video
				onError={handleError}
				src={url}
				controls
				controlsList={mediaControlsList(downloadable)}
				preload="metadata"
				aria-label={name}
				className="max-h-72 max-w-sm rounded-2xl"
			/>
		)
	}

	return (
		<audio
			onError={handleError}
			src={url}
			controls
			controlsList={mediaControlsList(downloadable)}
			preload="metadata"
			aria-label={name}
			className="w-64"
		/>
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
	downloadable,
	fallback
}: {
	item: DriveItem
	name: string
	category: StreamedCategory
	downloadable: boolean
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
			downloadable={downloadable}
			fallback={fallback}
		/>
	)
}

// Compact card for a Filen public link (file or directory) pasted into a message — the branch point
// for every resolved category: a previewable image/video/audio gets an inline thumbnail/mini-player, a
// previewable-but-not-inline-rendered file (pdf/docx/text/code/markdown/archive) gets a rich click-to-preview
// card showing its real size, and a non-previewable file OR any directory link opens a new tab
// (target=_blank to the raw link url, which now lands on the unauthenticated public-link viewer at the
// /f/ /d/ routes — new-format links directly, legacy-format links via the index route's redirect). The
// dispatch here is unchanged by that viewer shipping; the richer inline-preview dispatch is its own
// step. Resolution itself is unchanged — the authenticated in-app client, same as the reference mobile
// client.
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

	if (!resolution?.success) {
		const Icon = link.type === "directory" ? FolderIcon : FileIcon

		return (
			<LinkCardShell
				icon={
					<Icon
						aria-hidden="true"
						className="size-5 shrink-0 text-muted-foreground"
					/>
				}
				name={link.uuid}
				subtitle={t(link.type === "directory" ? "chatEmbedFilenDirectory" : "chatEmbedFilenFile")}
				ariaLabel={t("chatEmbedOpenNewTab", { name: link.uuid })}
				href={url}
			/>
		)
	}

	const { data } = resolution

	if (data.type === "directory") {
		const name = data.name ?? link.uuid

		return (
			<LinkCardShell
				icon={
					<DirectoryGlyph
						color="default"
						className="size-5 shrink-0"
					/>
				}
				name={name}
				subtitle={formatShortDate(data.timestamp)}
				ariaLabel={t("chatEmbedOpenNewTab", { name })}
				href={url}
			/>
		)
	}

	const name = data.name ?? link.uuid
	const item = linkedFileIntoDriveItem(data.linkedFile)
	const sizeLabel = formatBytes(Number(data.size))
	const { downloadable } = data.linkedFile
	const icon = (
		<ItemIcon
			item={item}
			className="size-5 shrink-0"
		/>
	)

	if (isStreamedCategory(data.previewCategory)) {
		return (
			<FilenInlineMedia
				item={item}
				name={name}
				category={data.previewCategory}
				downloadable={downloadable}
				fallback={
					<FilenPreviewCard
						item={item}
						name={name}
						subtitle={sizeLabel}
						icon={icon}
						downloadable={downloadable}
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

	// pdf | docx | text | code | markdown | archive (the overlay's archive browser, extracting only when the
	// link allows downloads)
	return (
		<FilenPreviewCard
			item={item}
			name={name}
			subtitle={sizeLabel}
			icon={icon}
			downloadable={downloadable}
		/>
	)
}
