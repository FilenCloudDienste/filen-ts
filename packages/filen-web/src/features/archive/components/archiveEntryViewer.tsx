import { useEffect, useEffectEvent, useLayoutEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { CATEGORY_POLICY, type PreviewCategory } from "@/features/drive/lib/preview.logic"
import { PreviewDownloadableProvider, usePreviewAccessMode } from "@/features/preview/lib/accessMode"
import type { ArchiveSource } from "@/features/archive/lib/archiveSource"
import type { EntryStore } from "@/features/archive/lib/entryStore"
import { entryReferences } from "@/features/archive/lib/entryReferences"
import { archiveEntryItem } from "@/features/archive/lib/entryItem"
import type { EntryRequest } from "@/features/archive/lib/entryDownload"
import { isArchivePasswordError } from "@/features/archive/lib/archiveBrowser.logic"
import { entryAccessOf, entryLeaseOrigin, leaseEntry } from "@/features/archive/lib/archiveHandle"
import type { EntryAccessKind } from "@/lib/sdk/byteOrigin"
import { PreviewErrorState, PreviewLoading, PreviewUnsupportedState } from "@/features/preview/components/previewErrorState"
import { ExtractToRead } from "@/features/archive/components/extractToRead"
import {
	entryExtractCard,
	entryPlanOf,
	sniffMayReadByRange,
	sniffOpensOnlyByAccess,
	type ExtractReason
} from "@/features/archive/lib/entryAccess.logic"
import { ArchiveWaiting } from "@/features/archive/components/archiveStatus"
import { ArchivePasswordGate } from "@/features/archive/components/archivePasswordPrompt"
import { NestedFileViewer } from "@/features/preview/components/nestedFileViewer"
import type { DriveItem } from "@/features/drive/lib/item"
import type { ReaderTarget } from "@/features/archive/lib/archiveReaders"
import { IworkPreview } from "@/features/iwork/components/iworkPreview"

export interface ViewedEntry {
	request: EntryRequest
	// Null: its content read picks the viewer (entryAwaitsSniff).
	category: PreviewCategory | null
	// NaN when absent.
	modified: number
	encrypted: boolean
	// Not read from here: its card offers to extract the archive instead (a solid block too large).
	extract?: ExtractReason | undefined
	// An iWork document: its package as an archive of its own, whose rendering is shown instead of the entry read whole.
	iwork?: ReaderTarget | undefined
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
	// The archive may be extracted from here (the link's download flag, or a trashed file's extract): its "Extract to …"
	// cards offer it only then.
	extractAllowed: boolean
}

// One entry shown in the archive browser's place: read through the archive's reader, or, one not read from here (a
// solid block too large), the card offering to extract the archive.
export function ArchiveEntryViewer(props: ArchiveEntryViewerProps) {
	if (props.entry.extract !== undefined) {
		return (
			<EntryExtractCard
				{...props}
				reason={props.entry.extract}
			/>
		)
	}

	return props.entry.iwork === undefined ? (
		<ReadEntryViewer {...props} />
	) : (
		<IworkEntryViewer
			{...props}
			target={props.entry.iwork}
		/>
	)
}

// A Pages, Numbers or Keynote document in the archive, shown as the drive shows one: its package listed through a reader
// of its own (nested in the archive's) and the rendering it carries read, never the entry whole.
function IworkEntryViewer({ archiveUuid, entry, onDownload, onBack, target }: ArchiveEntryViewerProps & { target: ReaderTarget }) {
	const { t } = useTranslation("preview")
	const { request } = entry
	const item = archiveEntryItem(archiveUuid, request.params.entry.index, request.name, request.size, entry.modified)

	return (
		<NestedFileViewer
			item={item}
			origin={entryLeaseOrigin("", request.target.uuid, request.anon, request.params.entry.index, request.size)}
			category="iwork"
			references={null}
			backLabel={t("previewArchiveEntryBack")}
			onBack={onBack}
			onDownload={onDownload}
			replacement={
				// A viewer's own save is the document's, as the header's is.
				<PreviewDownloadableProvider
					downloadable={onDownload !== null}
					onDownload={onDownload}
				>
					<IworkPreview
						item={item}
						alt={request.name}
						target={target}
					/>
				</PreviewDownloadableProvider>
			}
		/>
	)
}

// The card's body: why the entry is not shown here, and the extract that would show it (where allowed).
function EntryExtractBody({
	item,
	name,
	source,
	reason,
	extractAllowed
}: {
	item: DriveItem
	name: string
	source: ArchiveSource
	reason: ExtractReason
	extractAllowed: boolean
}) {
	const { t } = useTranslation("preview")
	// Inside an archive held in another, only the outermost one extracts: the card says so, and offers nothing here.
	const message =
		source.nested !== null
			? t("previewArchiveEntryNestedCardBody", { name })
			: reason === "read"
				? t("previewArchiveEntryExtractToRead", { name })
				: reason === "play"
					? t("previewArchiveEntryExtractToPlayBody", { name })
					: t("previewArchiveEntryExtractToOpenBody", { name })
	const label =
		reason === "read" ? undefined : reason === "play" ? t("previewArchiveEntryExtractToPlay") : t("previewArchiveEntryExtractToOpen")

	return (
		<PreviewUnsupportedState
			item={item}
			message={message}
			secondary={
				extractAllowed ? (
					<ExtractToRead
						source={source}
						label={label}
					/>
				) : undefined
			}
		/>
	)
}

function EntryExtractCard({
	archiveUuid,
	entry,
	onBack,
	listing,
	reason,
	extractAllowed
}: ArchiveEntryViewerProps & { reason: ExtractReason }) {
	const { t } = useTranslation("preview")
	const { request } = entry
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
				<EntryExtractBody
					item={item}
					name={request.name}
					source={listing.source}
					reason={reason}
					extractAllowed={extractAllowed}
				/>
			}
		/>
	)
}

// The entry's access kind for the lease and password it was asked under, or why it could not be told.
type AccessAnswer = { key: string; kind: EntryAccessKind } | { key: string; error: ErrorDTO }

// One entry read and shown in the archive browser's place, read-only, with the viewers a drive file of its kind
// gets. Its bytes come through the entry's origin, a lease on the archive's reader for each password tried (the
// listing's own reader for its password), cached like a file's under the entry's key. An encrypted entry without a
// password asks first; a password the SDK refuses (a whole read's, a range read's, a RAW walk's) asks again.
function ReadEntryViewer({
	archiveUuid,
	entry,
	password: listingPassword,
	onPasswordAccepted,
	onDownload,
	onBack,
	listing,
	readAhead,
	extractAllowed
}: ArchiveEntryViewerProps) {
	const { t } = useTranslation(["preview", "common"])
	const [password, setPassword] = useState(listingPassword)
	const [ask, setAsk] = useState<{ wrong: boolean } | null>(entry.encrypted && listingPassword === undefined ? { wrong: false } : null)
	// Remounts the viewer, so a new password loads again.
	const [attempt, setAttempt] = useState(0)
	// A failed access lookup asked again.
	const [lookup, setLookup] = useState(0)
	const [waiting, setWaiting] = useState(false)
	const [readerBase] = useState(() => crypto.randomUUID())
	const { request } = entry
	const item = archiveEntryItem(archiveUuid, request.params.entry.index, request.name, request.size, entry.modified)
	// One lease per password tried; the viewer below remounts with it.
	const leaseId = `${readerBase}:${String(attempt)}`
	// A viewer that reads ranges (media, a RAW, a database) streams a mapped or seekable entry by range; the reader says
	// which. An entry whose content read picks its viewer is asked too when that read may find such a kind: its head is
	// then read by range, and media found by it plays (or shows its card) as one named so would.
	const ranged = entry.category === null ? sniffMayReadByRange(request.name) : CATEGORY_POLICY[entry.category].entry === "ranged"
	const [byteAccess, setByteAccess] = useState<AccessAnswer | null>(null)
	const accessKey = `${leaseId}:${password ?? ""}:${String(lookup)}`
	const answer = ranged && byteAccess?.key === accessKey ? byteAccess : null
	const kind = ranged ? (answer !== null && "kind" in answer ? answer.kind : null) : "whole"
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

		const controller = new AbortController()
		const asked = accessRequest()

		void entryAccessOf(asked.request.target, asked.password, asked.request.params.entry.index, controller.signal).then(
			next => {
				if (!controller.signal.aborted) {
					setByteAccess({ key: accessKey, kind: next })
				}
			},
			(e: unknown) => {
				if (controller.signal.aborted) {
					return
				}

				const dto = asErrorDTO(e)

				// A reader that cannot tell for a password (a refused one): read whole, which asks the password as before. Any
				// other failure (the network, the slot) is shown, not taken for an entry read only whole.
				setByteAccess(isArchivePasswordError(dto) ? { key: accessKey, kind: "whole" } : { key: accessKey, error: dto })
			}
		)

		return () => {
			controller.abort()
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

	// The "Extract to …" card for media and RAW the reader cannot serve from here: by its name, or by what its
	// content read found.
	const cardFor = (category: PreviewCategory | null): ExtractReason | null =>
		kind === null ? null : entryExtractCard(category, kind, request.size)
	// An entry whose read may find only media (or only a RAW), read whole above the buffer cap or front to back: its card
	// before any read, so no head read decodes the whole entry first.
	const card = cardFor(entry.category ?? sniffOpensOnlyByAccess(request.name))

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
				extractAllowed={extractAllowed}
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
			sniffedReplacement={sniffed => {
				const reason = cardFor(sniffed)

				return reason === null ? undefined : (
					<EntryExtractBody
						item={item}
						name={request.name}
						source={listing.source}
						reason={reason}
						extractAllowed={extractAllowed}
					/>
				)
			}}
			replacement={
				ask !== null ? (
					<ArchivePasswordGate
						name={request.name}
						wrong={ask.wrong}
						onSubmit={next => {
							setPassword(next)
							setAsk(null)
							setAttempt(attempt + 1)
						}}
					/>
				) : answer !== null && "error" in answer ? (
					<PreviewErrorState
						message={errorLabel(answer.error)}
						onRetry={() => {
							setLookup(lookup + 1)
						}}
					/>
				) : kind === null ? (
					// The reader is asked how the entry reads; back stays at hand meanwhile.
					<PreviewLoading />
				) : undefined
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
