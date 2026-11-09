import { PROBE_KV_PREFIX } from "@/features/videos/lib/probeService.logic"
import { ART_KV_PREFIX } from "@/features/videos/lib/artwork.logic"
import { FRAME_HINT_KV_PREFIX } from "@/features/videos/lib/frames.logic"

// Kv families derived from the library's files: each is rebuilt on demand from them. Watch state, grid and season
// choices under the same `videos.v1.` root are the user's own and are never among them.
export const NFO_KV_PREFIX = "videos.v1.nfo."
export const SUBTITLE_ENCODING_KV_PREFIX = "videos.v1.subenc."

export const VIDEO_CACHE_KV_PREFIXES: readonly string[] = [
	PROBE_KV_PREFIX,
	NFO_KV_PREFIX,
	ART_KV_PREFIX,
	FRAME_HINT_KV_PREFIX,
	SUBTITLE_ENCODING_KV_PREFIX
]
