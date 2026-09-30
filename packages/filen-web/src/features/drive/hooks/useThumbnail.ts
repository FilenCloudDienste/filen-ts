import { useEffect, useState } from "react"
import { type DriveItem } from "@/features/drive/lib/item"
import { getThumbnailUrl, peekThumbnailUrl } from "@/features/drive/lib/thumbnails"
import { thumbnailCategory } from "@/features/drive/lib/thumbnails.logic"

// side-effect: registers the sdk/video/pdf generators against the thumbnail service — upload.ts is
// the only other production importer (for its own warm path), and an unregistered category would
// otherwise silently resolve no thumbnail forever (getThumbnailUrl's own unregistered-generator path
// is a clean null, never a throw).
import "@/features/drive/lib/thumbGenerators"

// Bridges the thumbnail service's async getThumbnailUrl into render state for one drive item. Keyed
// on item.data.uuid rather than `item` itself: both the list and grid virtualizers key their virtual
// items by uuid, so a mounted row/tile is already scoped to one uuid for its whole lifetime — a
// metadata-only update (rename, favorite toggle) re-renders the SAME instance with a new `item`
// reference but an unchanged uuid, and re-running this effect for that would only churn a redundant
// promise against the service's own url cache for no visible gain. A genuine content change always
// rotates the uuid (backend semantics), which the listing's own uuid keying already remounts fresh,
// so no explicit reset is needed here. The initial state peeks the url cache, so an already-cached
// thumbnail paints on the cell's first frame; the effect then resolves the same string and bails out.
//
// Unmount withdraws this cell's interest but never cancels a generation in flight: rows/tiles mount and
// unmount rapidly under scroll, the service's own uuid-keyed pending/urls maps already make a
// re-mounted cell's call free (joins the still-running generation or reads the cached url), and every
// other cell for the same uuid, mounted now or later, needs that same result. Only a generation still
// queued for a slot whose cells have all unmounted is dropped (a fling through a large listing would
// otherwise download and decode every row it passed). `live` only guards the state write, so an
// unmounted cell's late resolve can never trigger a set-state-after-unmount warning.
export function useThumbnail(item: DriveItem): string | null {
	const [url, setUrl] = useState<string | null>(() => (thumbnailCategory(item) === "none" ? null : peekThumbnailUrl(item.data.uuid)))

	useEffect(() => {
		// Synchronous and cheap — skip the async round trip entirely for a category with no thumbnail
		// story (directory, unrecognized/svg extension, oversize, undecryptable).
		if (thumbnailCategory(item) === "none") {
			return
		}

		let live = true
		const controller = new AbortController()

		void getThumbnailUrl(item, undefined, controller.signal).then(resolved => {
			if (live) {
				setUrl(resolved)
			}
		})

		return () => {
			live = false
			controller.abort()
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- deliberate: keyed on uuid only, see the doc comment above
	}, [item.data.uuid])

	return url
}
