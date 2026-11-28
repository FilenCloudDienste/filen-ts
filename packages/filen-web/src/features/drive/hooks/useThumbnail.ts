import { use, useEffect, useEffectEvent, useRef, useState } from "react"
import type { FileVerdict } from "@filen/shared"
import { type DriveItem } from "@/features/drive/lib/item"
import { getThumbnailUrl, peekThumbnailUrl } from "@/features/drive/lib/thumbnails"
import { thumbnailCategory } from "@/features/drive/lib/thumbnails.logic"
import { ThumbnailRankContext } from "@/features/drive/lib/thumbnailRank"
import { ThumbnailSourceContext, type ThumbnailSource } from "@/features/drive/lib/thumbnailSource"
import { useFileKindVerdict } from "@/features/drive/hooks/useFileKindVerdict"

// side-effect: registers the sdk/video/pdf generators against the thumbnail service — upload.ts is
// the only other production importer (for its own warm path), and an unregistered category would
// otherwise silently resolve no thumbnail forever (getThumbnailUrl's own unregistered-generator path
// is a clean null, never a throw).
import "@/features/drive/lib/thumbGenerators"

// Whether `source` makes a thumbnail of the item at all: a directory, an unrecognized extension, an oversize or
// undecryptable file has none, nor a category the source does not produce.
function producedBy(source: ThumbnailSource, item: DriveItem, verdict?: FileVerdict): boolean {
	const category = thumbnailCategory(item, verdict)

	return category !== "none" && source.produces(category)
}

// What a cell can show without asking the service: null for an item its source makes no thumbnail of, the cached
// url, else undefined.
function initialThumbnail(source: ThumbnailSource, item: DriveItem): string | null | undefined {
	return producedBy(source, item) ? (peekThumbnailUrl(item.data.uuid) ?? undefined) : null
}

// Bridges the thumbnail service's async getThumbnailUrl into render state for one drive item: the url,
// null when there is none, or undefined while the service is still answering. A cached url is read on
// the cell's first render, so scrolling back to it paints the thumbnail on the first frame and asks the
// service nothing at all.
//
// Keyed on the uuid and on whether the item has a thumbnail story, never on `item` itself: a
// metadata-only update (rename, favorite toggle) re-renders the same cell with a new `item` reference,
// and re-asking for it would only churn the service for the same answer. A genuine content change
// rotates the uuid (backend semantics), which resets the state during render.
//
// Unmount withdraws this cell's interest; the service decides from there whether its generation is
// still worth running (see ThumbGenerator in thumbnails.ts). `index` is the cell's place in a
// virtualized listing, which ranks its generation against the rest while it waits for a slot. `generate` false asks
// the service nothing: only a thumbnail already cached shows until it turns true.
export function useThumbnail(item: DriveItem, index?: number, generate?: boolean): string | null | undefined {
	const uuid = item.data.uuid
	// The drive's own unless the listing says otherwise (a public link's: the public-link client, in memory only).
	const source = use(ThumbnailSourceContext)
	// A verdict landing later (a `.ts` read as a transport stream) can give the item a thumbnail story.
	const wanted = producedBy(source, item, useFileKindVerdict(uuid))
	const [state, setState] = useState(() => ({ uuid, wanted, url: initialThumbnail(source, item) }))
	let current = state

	if (state.uuid !== uuid || state.wanted !== wanted) {
		current = { uuid, wanted, url: initialThumbnail(source, item) }
		setState(current)
	}

	const settled = current.url !== undefined
	// Read when a slot frees, possibly long after this render: a re-sort can move the cell meanwhile.
	const rankOf = use(ThumbnailRankContext)
	const placement = useRef({ rankOf, index })

	useEffect(() => {
		placement.current = { rankOf, index }
	}, [rankOf, index])

	const resolve = useEffectEvent((signal: AbortSignal) =>
		getThumbnailUrl(item, source.deps, signal, () => {
			const { rankOf: rankAt, index: at } = placement.current

			return rankAt === null || at === undefined ? 0 : rankAt(at)
		})
	)

	useEffect(() => {
		if (settled || generate === false) {
			return
		}

		const controller = new AbortController()

		void resolve(controller.signal).then(url => {
			if (!controller.signal.aborted) {
				setState(prev => (prev.uuid === uuid ? { ...prev, url } : prev))
			}
		})

		return () => {
			controller.abort()
		}
	}, [uuid, settled, generate])

	return current.url
}
