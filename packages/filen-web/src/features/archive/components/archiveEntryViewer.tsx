import { useEffectEvent, useLayoutEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import type { ErrorDTO } from "@/lib/sdk/errors"
import type { PreviewCategory } from "@/features/drive/lib/preview.logic"
import { usePreviewAccessMode } from "@/features/preview/lib/accessMode"
import type { ArchiveSource } from "@/features/archive/lib/archiveSource"
import type { EntryStore } from "@/features/archive/lib/entryStore"
import { entryReferences } from "@/features/archive/lib/entryReferences"
import { archiveEntryItem } from "@/features/archive/lib/entryItem"
import { entryOrigin, isArchivePasswordError, openEntryReader, type EntryRequest } from "@/features/archive/lib/entryDownload"
import { ArchiveWaiting } from "@/features/archive/components/archiveStatus"
import { ArchivePasswordGate } from "@/features/archive/components/archivePasswordPrompt"
import { NestedFileViewer } from "@/features/preview/components/nestedFileViewer"

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
	// The archive's listing, where the entry's references (a model's textures) are found.
	listing: { source: ArchiveSource; store: EntryStore }
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
	onBack,
	listing
}: ArchiveEntryViewerProps) {
	const { t } = useTranslation(["preview", "common"])
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
	const access = usePreviewAccessMode()

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

	return (
		<NestedFileViewer
			item={item}
			origin={origin}
			category={entry.category}
			references={entryReferences(listing.source, listing.store, request.params.entry.index, password, access)}
			backLabel={t("previewArchiveEntryBack")}
			onBack={onBack}
			onDownload={onDownload}
			bodyKey={attempt}
			replacement={
				ask === null ? undefined : (
					<ArchivePasswordGate
						name={request.name}
						wrong={ask.wrong}
						onSubmit={next => {
							setPassword(next)
							setAsk(null)
							setAttempt(attempt + 1)
						}}
					/>
				)
			}
			overlay={
				waiting && ask === null ? (
					<div className="absolute inset-0 bg-background">
						<ArchiveWaiting onCancel={onBack} />
					</div>
				) : undefined
			}
		/>
	)
}
