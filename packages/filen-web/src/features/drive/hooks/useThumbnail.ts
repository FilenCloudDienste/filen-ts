import { useEffect, useState } from "react"
import { type DriveItem } from "@/features/drive/lib/item"
import { getThumbnailUrl } from "@/features/drive/lib/thumbnails"
import { thumbnailCategory } from "@/features/drive/lib/thumbnails.logic"

// side-effect: registers the heic/video/pdf client generators against the thumbnail service —
// nothing else in production imports thumbGenerators.ts, and an unregistered category would
// otherwise silently resolve no thumbnail forever (getThumbnailUrl's own unregistered-generator path
// is a clean null, never a throw).
import "@/features/drive/lib/thumbGenerators"

// Bridges the thumbnail service's async getThumbnailUrl into render state for one drive item. Keyed
// on item.data.uuid rather than `item` itself: both the list and grid virtualizers key their virtual
// items by uuid, so a mounted row/tile is already scoped to one uuid for its whole lifetime — a
// metadata-only update (rename, favorite toggle) re-renders the SAME instance with a new `item`
// reference but an unchanged uuid, and re-running this effect for that would only churn a redundant
// promise against the service's own url cache for no visible gain. A genuine content change always
// rotates the uuid (backend semantics), which the listing's own uuid keying already remounts fresh —
// a clean useState(null) start, no explicit reset needed here.
//
// No unmount cancellation: rows/tiles mount and unmount rapidly under scroll, but the service's own
// uuid-keyed pending/urls maps already make a re-mounted cell's call free (joins the still-running
// generation or reads the cached url), and a generation in flight must run to completion regardless
// of whether the cell that first requested it is still mounted — every other cell for the same uuid,
// mounted now or later, needs that same result. `live` only guards the state write, so an unmounted
// cell's late resolve can never trigger a set-state-after-unmount warning.
export function useThumbnail(item: DriveItem): string | null {
	const [url, setUrl] = useState<string | null>(null)

	useEffect(() => {
		// Synchronous and cheap — skip the async round trip entirely for a category with no thumbnail
		// story (directory, unrecognized/svg extension, oversize, undecryptable).
		if (thumbnailCategory(item) === "none") {
			return
		}

		let live = true

		void getThumbnailUrl(item).then(resolved => {
			if (live) {
				setUrl(resolved)
			}
		})

		return () => {
			live = false
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- deliberate: keyed on uuid only, see the doc comment above
	}, [item.data.uuid])

	return url
}
