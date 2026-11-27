import { type } from "arktype"
import { isResumablePosition } from "@filen/shared/videos"
import { kvLoadOnce, kvSetJsonQuiet } from "@/lib/storage/kvBestEffort"

// Where a long video opened from Drive or Photos was left, kept on this device across sessions so the next open
// resumes there. The Videos tab keeps its own synced progress for library titles (videos/lib/watchState.ts); this is
// the same resume rule (isResumablePosition: five minutes or longer, between 5% and 90%) for any other video, kept
// local and capped. Keyed by the file's stable uuid, which survives a content edit, so an entry also carries the
// version's uuid and size: a replaced file of another size starts from the top. Read during boot (lib/sdk/boot.ts),
// so an open reads it synchronously.

const KV_KEY = "media.videoResume.v1"

export const VIDEO_RESUME_CAP = 200

// [stableUuid, uuid, size, position (s), duration (s)], least recently used first.
const entrySchema = type(["string", "string", "number", "number", "number"])
const storeSchema = entrySchema.array()

type Entry = typeof entrySchema.infer

export interface ResumableFile {
	stableUuid: string
	uuid: string
	size: number
}

// Map insertion order is the LRU order: a write deletes and re-adds its key.
const entries = new Map<string, Entry>()
// Keys written or dropped this session before the stored list arrived; the load never overwrites them.
const touched = new Set<string>()

export const loadVideoResume = kvLoadOnce(
	KV_KEY,
	storeSchema,
	stored => {
		const live = [...entries.values()]

		entries.clear()

		for (const entry of stored) {
			if (!touched.has(entry[0])) {
				entries.set(entry[0], entry)
			}
		}

		for (const entry of live) {
			entries.set(entry[0], entry)
		}

		trim()
	},
	"media",
	"video resume positions"
)

function trim(): void {
	for (const key of entries.keys()) {
		if (entries.size <= VIDEO_RESUME_CAP) {
			return
		}

		entries.delete(key)
	}
}

function persist(): void {
	void kvSetJsonQuiet(KV_KEY, [...entries.values()], "media", "video resume positions")
}

// The remembered position for `file`, in seconds, or undefined.
export function videoResumeAt(file: ResumableFile): number | undefined {
	const entry = entries.get(file.stableUuid)

	if (entry === undefined || (entry[1] !== file.uuid && entry[2] !== file.size)) {
		return undefined
	}

	return entry[3]
}

// Records where playback stands. A position worth resuming is kept (most recent last, the oldest past the cap
// dropped); anything else (the end reached, near it, or barely started) forgets the file. Only a real change writes.
export function recordVideoResume(file: ResumableFile, positionSec: number, durationSec: number, ended: boolean): void {
	const key = file.stableUuid
	const existing = entries.get(key)

	touched.add(key)

	if (ended || !isResumablePosition({ pos: positionSec, dur: durationSec })) {
		if (existing !== undefined) {
			entries.delete(key)
			persist()
		}

		return
	}

	entries.delete(key)
	entries.set(key, [key, file.uuid, file.size, positionSec, durationSec])
	trim()

	if (existing?.[1] !== file.uuid || Math.abs(existing[3] - positionSec) >= 1) {
		persist()
	}
}
