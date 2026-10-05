import { useEffect, useEffectEvent, useState } from "react"
import { type DriveItem } from "@/features/drive/lib/item"
import { getThumbnailUrl, peekThumbnailUrl } from "@/features/drive/lib/thumbnails"
import { thumbnailCategory } from "@/features/drive/lib/thumbnails.logic"

// side-effect: registers the sdk/video/pdf generators against the thumbnail service — upload.ts is
// the only other production importer (for its own warm path), and an unregistered category would
// otherwise silently resolve no thumbnail forever (getThumbnailUrl's own unregistered-generator path
// is a clean null, never a throw).
import "@/features/drive/lib/thumbGenerators"

// What a cell can show without asking the service: null for a category with no thumbnail story
// (directory, unrecognized/svg extension, oversize, undecryptable), the cached url, else undefined.
function initialThumbnail(item: DriveItem): string | null | undefined {
	return thumbnailCategory(item) === "none" ? null : (peekThumbnailUrl(item.data.uuid) ?? undefined)
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
// still worth running (see ThumbGenerator in thumbnails.ts).
export function useThumbnail(item: DriveItem): string | null | undefined {
	const uuid = item.data.uuid
	const wanted = thumbnailCategory(item) !== "none"
	const [state, setState] = useState(() => ({ uuid, wanted, url: initialThumbnail(item) }))
	let current = state

	if (state.uuid !== uuid || state.wanted !== wanted) {
		current = { uuid, wanted, url: initialThumbnail(item) }
		setState(current)
	}

	const settled = current.url !== undefined
	const resolve = useEffectEvent((signal: AbortSignal) => getThumbnailUrl(item, undefined, signal))

	useEffect(() => {
		if (settled) {
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
	}, [uuid, settled])

	return current.url
}
