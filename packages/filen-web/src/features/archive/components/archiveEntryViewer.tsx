import { useEffect, useEffectEvent, useLayoutEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import type { ErrorDTO } from "@/lib/sdk/errors"
import type { PreviewCategory } from "@/features/drive/lib/preview.logic"
import { usePreviewAccessMode } from "@/features/preview/lib/accessMode"
import type { ArchiveSource } from "@/features/archive/lib/archiveSource"
import type { EntryStore } from "@/features/archive/lib/entryStore"
import { entryReferences } from "@/features/archive/lib/entryReferences"
import { archiveEntryItem } from "@/features/archive/lib/entryItem"
import { isArchivePasswordError, type EntryRequest } from "@/features/archive/lib/entryDownload"
import { entryAccessOf, entryLeaseOrigin, leaseEntry } from "@/features/archive/lib/archiveHandle"
import type { EntryAccessKind } from "@/lib/sdk/byteOrigin"
import { CATEGORY_POLICY, entryOpensByAccess } from "@/features/drive/lib/preview.logic"
import { PreviewLoading, PreviewUnsupportedState } from "@/features/preview/components/previewErrorState"
import { ExtractToRead } from "@/features/archive/components/extractToRead"
import { entryExtractCard, entryPlanOf } from "@/features/archive/lib/entryAccess.logic"
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
	// In a solid block too large to read from here (E3): its card offers to extract the archive instead.
	extractToRead?: boolean
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
	// The session accepted a solid cost: a solid block's entry reads the files after it ahead.
	readAhead: boolean
}

// One entry shown in the archive browser's place: read through the archive's reader, or, packed in a solid block too
// large to read from here (E3), the card offering to extract the archive.
export function ArchiveEntryViewer(props: ArchiveEntryViewerProps) {
	return props.entry.extractToRead === true ? (
		<EntryExtractCard
			{...props}
			reason="read"
		/>
	) : (
		<ReadEntryViewer {...props} />
	)
}

// Why an entry is extracted to be seen: a solid block too large (E3), media that cannot be played from here, a RAW
// whose preview cannot be read by range (W6 §3.10).
type ExtractReason = "read" | "play" | "open"

function EntryExtractCard({ archiveUuid, entry, onBack, listing, reason }: ArchiveEntryViewerProps & { reason: ExtractReason }) {
	const { t } = useTranslation("preview")
	const { request } = entry
	const message =
		reason === "read"
			? t("previewArchiveEntryExtractToRead", { name: request.name })
			: reason === "play"
				? t("previewArchiveEntryExtractToPlayBody", { name: request.name })
				: t("previewArchiveEntryExtractToOpenBody", { name: request.name })
	const label =
		reason === "read" ? undefined : reason === "play" ? t("previewArchiveEntryExtractToPlay") : t("previewArchiveEntryExtractToOpen")
	const item = archiveEntryItem(archiveUuid, request.params.entry.index, request.name, request.size, entry.modified)

	return (
		<NestedFileViewer
			item={item}
			origin={entryLeaseOrigin("", request.target.uuid, request.anon, request.params.entry.index, request.size)}
			category={entry.category}
			references={null}
			backLabel={t("previewArchiveEntryBack")}
			onBack={onBack}
			onDownload={null}
			replacement={
				<PreviewUnsupportedState
					item={item}
					message={message}
					secondary={
						<ExtractToRead
							source={listing.source}
							label={label}
						/>
					}
				/>
			}
		/>
	)
}

// One entry read and shown in the archive browser's place, read-only, with the viewers a drive file of its kind
// gets. Its bytes come through the entry's origin, a lease on the archive's reader for each password tried (the
// listing's own reader for its password), cached like a file's under the entry's key. An encrypted entry without a password asks first; a password the SDK refuses asks
// again.
function ReadEntryViewer({
	archiveUuid,
	entry,
	password: listingPassword,
	onPasswordAccepted,
	onDownload,
	onBack,
	listing,
	readAhead
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
	// One lease per password tried; the viewer below remounts with it.
	const leaseId = `${readerBase}:${String(attempt)}`
	// A viewer that reads ranges (a database) streams a mapped or seekable entry by range; the reader says which.
	const ranged = entry.category !== null && CATEGORY_POLICY[entry.category].entry === "ranged"
	// Video, audio and RAW open by their access kind, or as their "Extract to …" card.
	const opensByAccess = entryOpensByAccess(entry.category)
	const [byteAccess, setByteAccess] = useState<{ key: string; kind: EntryAccessKind } | null>(null)
	const accessKey = `${leaseId}:${password ?? ""}`
	const kind = ranged ? (byteAccess?.key === accessKey ? byteAccess.kind : null) : "whole"
	const origin = entryLeaseOrigin(leaseId, request.target.uuid, request.anon, request.params.entry.index, request.size, kind ?? "whole")
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
	const leaseRequest = useEffectEvent(() => ({
		request,
		password,
		plan: entryPlanOf(listing.store, request.params.entry.index, request.size, request.params.maxSolidSkip, readAhead)
	}))
	const access = usePreviewAccessMode()

	const accessRequest = useEffectEvent(() => ({ request, password }))

	useEffect(() => {
		if (!ranged) {
			return
		}

		let live = true
		const asked = accessRequest()

		// A reader that cannot tell (a refused password): read whole, which asks the password as before.
		void entryAccessOf(asked.request.target, asked.password, asked.request.params.entry.index)
			.catch((): EntryAccessKind => "whole")
			.then(next => {
				if (live) {
					setByteAccess({ key: accessKey, kind: next })
				}
			})

		return () => {
			live = false
		}
	}, [ranged, accessKey])

	// A layout effect: it runs before the viewer's own effects start reading through the lease.
	useLayoutEffect(() => {
		const opened = leaseRequest()

		return leaseEntry({
			leaseId,
			target: opened.request.target,
			password: opened.password,
			plan: opened.plan,
			events: {
				phase: phase => {
					onPhase(phase === "waitingForWorker")
				},
				verified: () => {
					onVerified()
				},
				failed: dto => {
					onFailed(dto)
				}
			}
		})
	}, [leaseId])

	if (kind === null && ask === null) {
		return <PreviewLoading />
	}

	const card = opensByAccess && kind !== null ? entryExtractCard(entry.category, kind, request.size) : null

	if (card !== null) {
		return (
			<EntryExtractCard
				archiveUuid={archiveUuid}
				entry={entry}
				password={listingPassword}
				onPasswordAccepted={onPasswordAccepted}
				onDownload={onDownload}
				onBack={onBack}
				listing={listing}
				readAhead={readAhead}
				reason={card}
			/>
		)
	}

	return (
		<NestedFileViewer
			item={item}
			origin={origin}
			category={entry.category}
			references={entryReferences(listing.source, listing.store, request.params.entry.index, password, access, () => readAhead)}
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
