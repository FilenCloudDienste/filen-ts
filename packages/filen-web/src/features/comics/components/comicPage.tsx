import { useEffect, useEffectEvent, useLayoutEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { formatBytes } from "@filen/shared"
import type { ErrorDTO } from "@/lib/sdk/errors"
import type { ArchiveSource } from "@/features/archive/lib/archiveSource"
import type { EntryStore } from "@/features/archive/lib/entryStore"
import { entryLeaseOrigin, leaseEntry } from "@/features/archive/lib/archiveHandle"
import { archiveEntryItem } from "@/features/archive/lib/entryItem"
import { entryReadPlan } from "@/features/archive/lib/entryAccess.logic"
import { ArchiveWaiting } from "@/features/archive/components/archiveStatus"
import { PreviewByteOriginProvider } from "@/features/preview/lib/accessMode"
import { ImageShownContext, type ShownImage } from "@/features/preview/lib/imageDisplay"
import { ReadOnlyPreviewBody } from "@/features/preview/components/readOnlyPreviewBody"
import { pageOpens } from "@/features/comics/lib/pages.logic"

export interface ComicPageProps {
	source: ArchiveSource
	store: EntryStore
	slot: number
	// Its place in the book, from 0, and the book's page count: what it is called.
	position: number
	total: number
	password: string | undefined
	// The session accepted a solid cost: a solid block's page reads the pages after it ahead, this many at most
	// (readAheadEntries).
	readAhead: boolean
	aheadEntries: number
	// The page is on screen (or failed, or shows its placeholder): the reader may read ahead. `image`: its size, when
	// one is shown (a two-page scan is wider than tall).
	onShown: (image: ShownImage | null) => void
	// Its checksum proved the password it was read with.
	onVerified: () => void
	onFailed: (error: ErrorDTO) => void
	onCancelWait: () => void
}

// One page of a comic: W2's image viewer over the page's entry, read through a lease on the archive's reader (the
// listing's own, for its password), cached like a file's under the entry's key. A page above the image cap keeps its
// place with a note instead.
export function ComicPage(props: ComicPageProps) {
	const { store, slot, position, total, onShown } = props
	const { t } = useTranslation("preview")
	const shown = useEffectEvent(onShown)

	useEffect(() => {
		if (!pageOpens(store, slot)) {
			shown(null)
		}
	}, [store, slot])

	if (!pageOpens(store, slot)) {
		return (
			<div
				data-comic-page=""
				className="flex h-full min-w-0 flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground"
			>
				{t("previewComicPageTooLarge", { page: position + 1, size: formatBytes(store.size(slot)) })}
			</div>
		)
	}

	return (
		<ShownComicPage
			{...props}
			alt={t("previewComicPageOf", { page: position + 1, total })}
		/>
	)
}

function ShownComicPage({
	source,
	store,
	slot,
	password,
	readAhead,
	aheadEntries,
	alt,
	onShown,
	onVerified,
	onFailed,
	onCancelWait
}: ComicPageProps & { alt: string }) {
	const [leaseBase] = useState(() => crypto.randomUUID())
	const [waiting, setWaiting] = useState(false)
	const leaseId = `${leaseBase}:${String(slot)}:${password ?? ""}`
	const origin = entryLeaseOrigin(leaseId, source.uuid, source.anon, store.index(slot), store.size(slot))
	const item = archiveEntryItem(source.uuid, store.index(slot), store.name(slot), store.size(slot), store.modified(slot))
	const leaseRequest = useEffectEvent(() => ({ plan: entryReadPlan(store, slot, readAhead, undefined, aheadEntries), password }))
	const phase = useEffectEvent((waitingForWorker: boolean) => {
		setWaiting(waitingForWorker)
	})
	const verified = useEffectEvent(onVerified)
	const failed = useEffectEvent((dto: ErrorDTO) => {
		// A page that cannot be read is done with: the reader reads on.
		onShown(null)
		onFailed(dto)
	})

	// A layout effect: it runs before the viewer's own effects start reading through the lease.
	useLayoutEffect(() => {
		const request = leaseRequest()

		return leaseEntry({
			leaseId,
			target: source,
			password: request.password,
			plan: request.plan,
			events: {
				phase: next => {
					phase(next === "waitingForWorker")
				},
				verified: () => {
					verified()
				},
				failed: dto => {
					failed(dto)
				}
			}
		})
	}, [leaseId, source.file, source.anon])

	return (
		<div
			data-comic-page=""
			className="relative h-full min-w-0 flex-1"
		>
			<ImageShownContext value={onShown}>
				<PreviewByteOriginProvider origin={origin}>
					<ReadOnlyPreviewBody
						item={item}
						category="image"
						alt={alt}
					/>
				</PreviewByteOriginProvider>
			</ImageShownContext>
			{waiting ? (
				<div className="absolute inset-0 bg-background">
					<ArchiveWaiting onCancel={onCancelWait} />
				</div>
			) : null}
		</div>
	)
}
