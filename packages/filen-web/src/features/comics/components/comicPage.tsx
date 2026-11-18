import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react"
import type { ErrorDTO } from "@/lib/sdk/errors"
import type { ArchiveSource } from "@/features/archive/lib/archiveSource"
import type { EntryStore } from "@/features/archive/lib/entryStore"
import { entryLeaseOrigin, leaseEntry } from "@/features/archive/lib/archiveHandle"
import { archiveEntryItem } from "@/features/archive/lib/entryItem"
import { entryReadPlan } from "@/features/archive/lib/entryAccess.logic"
import { ArchiveWaiting } from "@/features/archive/components/archiveStatus"
import { PreviewByteOriginProvider } from "@/features/preview/lib/accessMode"
import { ReadOnlyPreviewBody } from "@/features/preview/components/readOnlyPreviewBody"

export interface ComicPageProps {
	source: ArchiveSource
	store: EntryStore
	slot: number
	password: string | undefined
	// The session accepted a solid cost: a solid block's page reads the pages after it ahead.
	readAhead: boolean
	// The page's image turned out wider than tall: a two-page scan, shown alone in a spread.
	onLandscape: () => void
	// Its checksum proved the password it was read with.
	onVerified: () => void
	onFailed: (error: ErrorDTO) => void
	onCancelWait: () => void
}

// One page of a comic: W2's image viewer over the page's entry, read through a lease on the archive's reader (the
// listing's own, for its password), cached like a file's under the entry's key.
export function ComicPage({ source, store, slot, password, readAhead, onLandscape, onVerified, onFailed, onCancelWait }: ComicPageProps) {
	const [leaseBase] = useState(() => crypto.randomUUID())
	const [waiting, setWaiting] = useState(false)
	const container = useRef<HTMLDivElement>(null)
	const leaseId = `${leaseBase}:${String(slot)}:${password ?? ""}`
	const origin = entryLeaseOrigin(leaseId, source.file, source.anon, store.index(slot), store.size(slot))
	const item = archiveEntryItem(source.uuid, store.index(slot), store.name(slot), store.size(slot), store.modified(slot))
	const leaseRequest = useEffectEvent(() => ({ plan: entryReadPlan(store, slot, readAhead), password }))
	const phase = useEffectEvent((waitingForWorker: boolean) => {
		setWaiting(waitingForWorker)
	})
	const verified = useEffectEvent(onVerified)
	const failed = useEffectEvent(onFailed)
	const landscape = useEffectEvent(onLandscape)

	// A layout effect: it runs before the viewer's own effects start reading through the lease.
	useLayoutEffect(() => {
		const request = leaseRequest()

		return leaseEntry({
			leaseId,
			file: source.file,
			anon: source.anon,
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

	// The image's own load, heard in the capture phase (load does not bubble): its natural size tells a landscape page.
	useEffect(() => {
		const root = container.current

		if (root === null) {
			return
		}

		const onLoad = (event: Event): void => {
			const image = event.target

			if (image instanceof HTMLImageElement && image.naturalWidth > image.naturalHeight) {
				landscape()
			}
		}

		root.addEventListener("load", onLoad, true)

		return () => {
			root.removeEventListener("load", onLoad, true)
		}
	}, [])

	return (
		<div
			ref={container}
			className="relative h-full min-w-0 flex-1"
		>
			<PreviewByteOriginProvider origin={origin}>
				<ReadOnlyPreviewBody
					item={item}
					category="image"
					alt={store.name(slot)}
				/>
			</PreviewByteOriginProvider>
			{waiting ? (
				<div className="absolute inset-0 bg-background">
					<ArchiveWaiting onCancel={onCancelWait} />
				</div>
			) : null}
		</div>
	)
}
