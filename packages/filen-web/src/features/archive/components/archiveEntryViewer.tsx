import { useState, type KeyboardEvent } from "react"
import { useTranslation } from "react-i18next"
import { ArrowLeftIcon, DownloadIcon } from "lucide-react"
import { asErrorDTO } from "@/lib/sdk/errors"
import { useIsOnline } from "@/lib/useIsOnline"
import type { PreviewCategory } from "@/features/drive/lib/preview.logic"
import { PreviewByteSourceProvider, PreviewDownloadableProvider, type PreviewByteSource } from "@/features/preview/lib/accessMode"
import { ReadOnlyPreviewBody } from "@/features/preview/components/readOnlyPreviewBody"
import { archiveEntryItem } from "@/features/archive/lib/entryItem"
import { isArchivePasswordError, loadEntryBytes, type EntryRequest } from "@/features/archive/lib/entryDownload"
import { ArchiveWaiting } from "@/features/archive/components/archiveStatus"
import { ArchivePasswordGate } from "@/features/archive/components/archivePasswordPrompt"
import { Button } from "@/components/ui/button"

export interface ViewedEntry {
	request: EntryRequest
	category: PreviewCategory
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

// One entry shown in the archive browser's place, read-only, with the viewers a drive file of its kind
// gets. Its bytes come through the entry's byte source, cached like a file's under the entry's key. An
// encrypted entry without a password asks first; a password the SDK refuses asks again.
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
	const [password, setPassword] = useState(listingPassword)
	const [ask, setAsk] = useState<{ wrong: boolean } | null>(entry.encrypted && listingPassword === undefined ? { wrong: false } : null)
	// Remounts the viewer, so a new password loads again.
	const [attempt, setAttempt] = useState(0)
	const [waiting, setWaiting] = useState(false)
	const { request } = entry
	const item = archiveEntryItem(archiveUuid, request.params.entry.index, request.name, request.size, entry.modified)

	const source: PreviewByteSource = token =>
		loadEntryBytes(request, password, token, phase => {
			setWaiting(phase === "waitingForWorker")
		}).then(
			({ bytes, checked }) => {
				// A 7z entry without a CRC decodes under a wrong password too: nothing proven.
				if (password !== undefined && checked) {
					onPasswordAccepted(password)
				}

				return bytes
			},
			(e: unknown) => {
				const dto = asErrorDTO(e)

				if (isArchivePasswordError(dto)) {
					setAsk({ wrong: dto.kind === "ArchiveWrongPassword" || password !== undefined })
				}

				throw e
			}
		)

	// Escape goes back to the list unless something inside took it already (a find panel); keys from a
	// dialog portaled out of this subtree are not this one's.
	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
		if (
			event.key !== "Escape" ||
			event.defaultPrevented ||
			!(event.target instanceof Node) ||
			!event.currentTarget.contains(event.target)
		) {
			return
		}

		event.preventDefault()
		onBack()
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
					<PreviewByteSourceProvider
						key={attempt}
						source={source}
					>
						<PreviewDownloadableProvider
							downloadable={onDownload !== null}
							onDownload={onDownload}
						>
							<ReadOnlyPreviewBody
								item={item}
								category={entry.category}
								alt={request.name}
							/>
						</PreviewDownloadableProvider>
					</PreviewByteSourceProvider>
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
