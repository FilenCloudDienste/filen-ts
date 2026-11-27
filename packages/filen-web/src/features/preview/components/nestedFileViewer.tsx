import { isImeKeydown, matchesCombo } from "@filen/shared/keymap"
import type { KeyboardEvent, ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { ArrowLeftIcon, DownloadIcon } from "lucide-react"
import { isRecordingCombo, useBindings } from "@/lib/keymap/registry"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { bindingOf } from "@/lib/keymap/bindingOf"
import { ARCHIVE_ACTIONS } from "@/features/archive/lib/keymap"
import { useIsOnline } from "@/lib/useIsOnline"
import type { PreviewCategory } from "@/features/drive/lib/preview.logic"
import type { DriveItem } from "@/features/drive/lib/item"
import type { ByteOrigin } from "@/lib/sdk/byteOrigin"
import { PreviewByteOriginProvider, PreviewDownloadableProvider } from "@/features/preview/lib/accessMode"
import { PreviewReferenceSourceContext, type ReferenceSourceFactory } from "@/features/preview/lib/referenceResolver"
import { ReadOnlyPreviewBody } from "@/features/preview/components/readOnlyPreviewBody"
import { ContentSniffGate } from "@/features/preview/components/contentSniffGate"
import { PreviewUnsupportedState } from "@/features/preview/components/previewErrorState"
import { sniffedEntryCategory } from "@/features/archive/lib/entryAccess.logic"
import { Button } from "@/components/ui/button"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { Kbd } from "@/lib/keymap/kbd"

const IS_MAC = isMacPlatform()
const BACK = ARCHIVE_ACTIONS.find(def => def.id === "archive.back")
const DOWNLOAD = ARCHIVE_ACTIONS.find(def => def.id === "archive.download")
const NO_REFERENCES: ReferenceSourceFactory = () => null

export interface NestedFileViewerProps {
	// The stand-in item (embeddedFileItem) and its own origin.
	item: DriveItem
	origin: ByteOrigin
	// Null: its content read picks the viewer.
	category: PreviewCategory | null
	// Where the files it references are found (an archive's other entries); null for nowhere (never the drive around the
	// container: the file is not in it).
	references: ReferenceSourceFactory | null
	// The back button's label, naming what it goes back to.
	backLabel: string
	onBack: () => void
	// Null where it may not be saved (a link allowing no downloads).
	onDownload: (() => void) | null
	// Shown instead of the file (a password it needs first), and over it (a wait it can be cancelled from).
	replacement?: ReactNode
	overlay?: ReactNode
	// A new key remounts the viewer, so it reads again (another password).
	bodyKey?: string | number
	// Shown instead of the viewer its content read found, when that kind is not shown from here (an "Extract to …"
	// card); undefined for the viewer.
	sniffedReplacement?: ((category: PreviewCategory) => ReactNode | undefined) | undefined
}

// The file's viewer: the one its name picked, else the one its content read found.
function NestedBody({
	item,
	origin,
	category,
	sniffedReplacement
}: {
	item: DriveItem
	origin: ByteOrigin
	category: PreviewCategory | null
	sniffedReplacement: NestedFileViewerProps["sniffedReplacement"]
}) {
	const { t } = useTranslation("preview")
	const shown = category ?? sniffedEntryCategory(item, origin)

	if (shown === null) {
		return (
			<PreviewUnsupportedState
				item={item}
				message={t("previewUnsupportedType")}
			/>
		)
	}

	const replaced = category === null ? sniffedReplacement?.(shown) : undefined

	if (replaced !== undefined) {
		return replaced
	}

	return (
		<ReadOnlyPreviewBody
			item={item}
			category={shown}
			alt={item.data.decryptedMeta?.name ?? ""}
		/>
	)
}

// A file held inside another (an archive's entry, a message's attachment) shown in its container's place, read-only,
// with the viewers a drive file of its kind gets, its bytes from its own origin. The back key (Escape, Alt+Left) goes
// back and Mod+S saves it, unless something inside took the key already (a find panel's Escape); keys from a dialog
// portaled out of this subtree are not this one's. Back is not taken in a text field, where Alt+Left moves the caret
// (Escape still leaves). Both are stopped here, so the overlay's own close and download never see them.
export function NestedFileViewer({
	item,
	origin,
	category,
	references,
	backLabel,
	onBack,
	onDownload,
	replacement,
	overlay,
	bodyKey,
	sniffedReplacement
}: NestedFileViewerProps) {
	const { t } = useTranslation(["preview", "common"])
	const isOnline = useIsOnline()
	const bindings = useBindings()
	const name = item.data.decryptedMeta?.name ?? ""

	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
		if (
			event.defaultPrevented ||
			isImeKeydown(event.nativeEvent) ||
			isRecordingCombo() ||
			!(event.target instanceof Node) ||
			!event.currentTarget.contains(event.target)
		) {
			return
		}

		const back = BACK !== undefined && matchesCombo(event, bindingOf(bindings, BACK, IS_MAC), IS_MAC)
		const save = !back && DOWNLOAD !== undefined && matchesCombo(event, bindingOf(bindings, DOWNLOAD, IS_MAC), IS_MAC)
		const inField = event.target instanceof Element && event.target.matches("input, textarea")

		if ((!back && !save) || (back && inField && event.key !== "Escape")) {
			return
		}

		event.preventDefault()
		event.stopPropagation()

		if (event.repeat) {
			return
		}

		if (back) {
			onBack()
		} else if (isOnline) {
			onDownload?.()
		}
	}

	const body = (
		<PreviewDownloadableProvider
			downloadable={onDownload !== null}
			onDownload={onDownload}
		>
			<ContentSniffGate
				item={item}
				asText={false}
				render={() => (
					<NestedBody
						item={item}
						origin={origin}
						category={category}
						sniffedReplacement={sniffedReplacement}
					/>
				)}
			/>
		</PreviewDownloadableProvider>
	)

	// A surface of its own (data-preview-surface): the overlay leaves its keys alone, so Left/Right stay off
	// the pager and Escape reaches handleKeyDown. Focusable, so a click into a viewer keeps focus inside.
	return (
		<div
			tabIndex={-1}
			data-preview-surface=""
			className="flex size-full flex-col outline-none"
			onKeyDown={handleKeyDown}
		>
			<div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2">
				{/* The list it replaced had focus. */}
				<Button
					autoFocus
					variant="ghost"
					size="sm"
					onClick={onBack}
				>
					<ArrowLeftIcon data-icon="inline-start" />
					{backLabel}
				</Button>
				<span
					className="min-w-0 flex-1 truncate text-sm"
					title={name}
				>
					{name}
				</span>
				{onDownload !== null ? (
					<TooltipIconButton
						disabled={!isOnline}
						label={t("previewDownloadAction")}
						title={t("common:offlineActionDisabled")}
						shortcut={<Kbd action="archive.download" />}
						onClick={onDownload}
					>
						<DownloadIcon />
					</TooltipIconButton>
				) : null}
			</div>
			<div className="relative min-h-0 flex-1">
				{replacement ?? (
					<PreviewByteOriginProvider
						key={bodyKey}
						origin={origin}
					>
						<PreviewReferenceSourceContext value={references ?? NO_REFERENCES}>{body}</PreviewReferenceSourceContext>
					</PreviewByteOriginProvider>
				)}
				{overlay}
			</div>
		</div>
	)
}
