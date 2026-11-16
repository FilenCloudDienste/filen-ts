import { isImeKeydown, matchesCombo } from "@filen/shared/keymap"
import { isRecordingCombo, useBindings } from "@/lib/keymap/registry"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { bindingOf } from "@/lib/keymap/bindingOf"
import { ARCHIVE_ACTIONS } from "@/features/archive/lib/keymap"
import { useEffectEvent, useLayoutEffect, useState, type KeyboardEvent } from "react"
import { useTranslation } from "react-i18next"
import { ArrowLeftIcon, DownloadIcon } from "lucide-react"
import type { ErrorDTO } from "@/lib/sdk/errors"
import { useIsOnline } from "@/lib/useIsOnline"
import type { PreviewCategory } from "@/features/drive/lib/preview.logic"
import type { DriveItem } from "@/features/drive/lib/item"
import { PreviewByteOriginProvider, PreviewDownloadableProvider } from "@/features/preview/lib/accessMode"
import { ReadOnlyPreviewBody } from "@/features/preview/components/readOnlyPreviewBody"
import { ContentSniffGate } from "@/features/preview/components/contentSniffGate"
import { PreviewUnsupportedState } from "@/features/preview/components/previewErrorState"
import { archiveEntryItem } from "@/features/archive/lib/entryItem"
import { sniffedEntryCategory } from "@/features/archive/lib/entryAccess.logic"
import { entryOrigin, isArchivePasswordError, openEntryReader, type EntryRequest } from "@/features/archive/lib/entryDownload"
import { ArchiveWaiting } from "@/features/archive/components/archiveStatus"
import { ArchivePasswordGate } from "@/features/archive/components/archivePasswordPrompt"
import { Button } from "@/components/ui/button"

const IS_MAC = isMacPlatform()
const BACK = ARCHIVE_ACTIONS.find(def => def.id === "archive.back")
const DOWNLOAD = ARCHIVE_ACTIONS.find(def => def.id === "archive.download")

export interface ViewedEntry {
	request: EntryRequest
	// Null: its content read picks the viewer (entryAwaitsSniff).
	category: PreviewCategory | null
	// NaN when absent.
	modified: number
	encrypted: boolean
}

export interface ArchiveEntryViewerProps {
	archiveUuid: string
	entry: ViewedEntry
	// The listing's accepted password, if any.
	password: string | undefined
	onPasswordAccepted: (password: string) => void
	// Null where the entry may not be saved (a link allowing no downloads).
	onDownload: (() => void) | null
	onBack: () => void
}

// The entry's viewer: the one its name picked, else the one its content read found.
function EntryBody({ item, category, alt }: { item: DriveItem; category: PreviewCategory | null; alt: string }) {
	const { t } = useTranslation("preview")
	const shown = category ?? sniffedEntryCategory(item)

	if (shown === null) {
		return (
			<PreviewUnsupportedState
				item={item}
				message={t("previewUnsupportedType")}
			/>
		)
	}

	return (
		<ReadOnlyPreviewBody
			item={item}
			category={shown}
			alt={alt}
		/>
	)
}

// One entry shown in the archive browser's place, read-only, with the viewers a drive file of its kind
// gets. Its bytes come through the entry's origin, an entry reader opened for each password tried, cached like a
// file's under the entry's key. An encrypted entry without a password asks first; a password the SDK refuses asks
// again.
export function ArchiveEntryViewer({
	archiveUuid,
	entry,
	password: listingPassword,
	onPasswordAccepted,
	onDownload,
	onBack
}: ArchiveEntryViewerProps) {
	const { t } = useTranslation(["preview", "common"])
	const isOnline = useIsOnline()
	const bindings = useBindings()
	const [password, setPassword] = useState(listingPassword)
	const [ask, setAsk] = useState<{ wrong: boolean } | null>(entry.encrypted && listingPassword === undefined ? { wrong: false } : null)
	// Remounts the viewer, so a new password loads again.
	const [attempt, setAttempt] = useState(0)
	const [waiting, setWaiting] = useState(false)
	const [readerBase] = useState(() => crypto.randomUUID())
	const { request } = entry
	const item = archiveEntryItem(archiveUuid, request.params.entry.index, request.name, request.size, entry.modified)
	// One reader per password tried; the viewer below remounts with it.
	const readerId = `${readerBase}:${String(attempt)}`
	const origin = entryOrigin(request, readerId, item.data.uuid)
	const onPhase = useEffectEvent((waitingForWorker: boolean) => {
		setWaiting(waitingForWorker)
	})
	// A 7z entry without a CRC decodes under a wrong password too: only a matched checksum proves it.
	const onVerified = useEffectEvent(() => {
		if (password !== undefined) {
			onPasswordAccepted(password)
		}
	})
	const onFailed = useEffectEvent((dto: ErrorDTO) => {
		if (isArchivePasswordError(dto)) {
			setAsk({ wrong: dto.kind === "ArchiveWrongPassword" || password !== undefined })
		}
	})
	const readerRequest = useEffectEvent(() => ({ request, password }))

	// A layout effect: it runs before the viewer's own effects start reading through the reader.
	useLayoutEffect(() => {
		const opened = readerRequest()

		return openEntryReader(opened.request, readerId, opened.password, {
			phase: phase => {
				onPhase(phase === "waitingForWorker")
			},
			verified: () => {
				onVerified()
			},
			failed: dto => {
				onFailed(dto)
			}
		})
	}, [readerId])

	// The back key (Escape, Alt+Left) goes back to the list and Mod+S saves the entry, unless something inside took the
	// key already (a find panel's Escape); keys from a dialog portaled out of this subtree are not this one's. Back is
	// not taken in a text field, where Alt+Left moves the caret (Escape still leaves). Both are stopped here, so the
	// overlay's own close and download never see them.
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
					{t("previewArchiveEntryBack")}
				</Button>
				<span
					className="min-w-0 flex-1 truncate text-sm"
					title={request.name}
				>
					{request.name}
				</span>
				{onDownload !== null ? (
					<Button
						variant="ghost"
						size="icon-sm"
						disabled={!isOnline}
						aria-label={t("previewDownloadAction")}
						title={isOnline ? undefined : t("common:offlineActionDisabled")}
						onClick={onDownload}
					>
						<DownloadIcon />
					</Button>
				) : null}
			</div>
			<div className="relative min-h-0 flex-1">
				{ask !== null ? (
					<ArchivePasswordGate
						name={request.name}
						wrong={ask.wrong}
						onSubmit={next => {
							setPassword(next)
							setAsk(null)
							setAttempt(attempt + 1)
						}}
					/>
				) : (
					<PreviewByteOriginProvider
						key={attempt}
						origin={origin}
					>
						<PreviewDownloadableProvider
							downloadable={onDownload !== null}
							onDownload={onDownload}
						>
							<ContentSniffGate
								item={item}
								asText={false}
								render={() => (
									<EntryBody
										item={item}
										category={entry.category}
										alt={request.name}
									/>
								)}
							/>
						</PreviewDownloadableProvider>
					</PreviewByteOriginProvider>
				)}
				{waiting && ask === null ? (
					<div className="absolute inset-0 bg-background">
						<ArchiveWaiting onCancel={onBack} />
					</div>
				) : null}
			</div>
		</div>
	)
}
