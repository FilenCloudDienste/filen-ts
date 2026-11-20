import { createContext } from "react"
import type { ThumbGeneratorCategory, ThumbnailServiceDeps } from "@/features/drive/lib/thumbnails"

// Where a cell's thumbnail comes from: the service's collaborators (undefined: the drive's own, the session client's
// generators and the OPFS cache), and the categories they produce. A cell of a category its source does not produce
// shows its icon and asks the service nothing.
export interface ThumbnailSource {
	readonly deps: ThumbnailServiceDeps | undefined
	readonly produces: (category: ThumbGeneratorCategory) => boolean
}

export const DRIVE_THUMBNAIL_SOURCE: ThumbnailSource = {
	deps: undefined,
	produces: () => true
}

export const ThumbnailSourceContext = createContext<ThumbnailSource>(DRIVE_THUMBNAIL_SOURCE)
