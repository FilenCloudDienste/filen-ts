import { create } from "zustand"
import { kvDelete, kvEntriesJson, kvGetJson } from "@/lib/storage/adapter"
import { kvSetJsonQuiet } from "@/lib/storage/kvBestEffort"
import { log } from "@/lib/log"
import {
	planTrackTagEvictions,
	trackTagRecordSchema,
	trackTagsKey,
	TRACK_TAGS_KV_PREFIX,
	TRACK_TAGS_MAX_RECORDS,
	type TrackTagRecord
} from "@/features/audio/lib/trackTags.logic"

// The reactive, session-wide view of every persisted track-tag record: the one source of truth for a
// track's title/artist/album/duration, read by the playlist table, the player bar and the OS media
// surface alike. Hydrated from kv once, on first use, in a single round trip; every write lands in
// memory at once and in kv behind it.
interface TrackTagsStore {
	byUuid: Record<string, TrackTagRecord>
	hydrated: boolean
}

export const useTrackTagsStore = create<TrackTagsStore>(() => ({ byUuid: {}, hydrated: false }))

let hydration: Promise<void> | null = null
// Bumped by reset so a hydration still in flight at logout cannot write the old account's rows back.
let epoch = 0
// Durations the media element reported before the track's record existed (the parse was still running,
// or the container carries none), merged into the record when it lands.
const elementDurations = new Map<string, number>()

function persist(uuid: string, record: TrackTagRecord): void {
	void kvSetJsonQuiet(trackTagsKey(uuid), record, "audio", "track tags")
}

export function hydrateTrackTags(): Promise<void> {
	if (hydration !== null) {
		return hydration
	}

	const hydrationEpoch = epoch

	hydration = kvEntriesJson(TRACK_TAGS_KV_PREFIX, trackTagRecordSchema)
		.then(rows => {
			if (hydrationEpoch !== epoch) {
				return
			}

			const records = rows.map(([key, record]): [string, TrackTagRecord] => [key.slice(TRACK_TAGS_KV_PREFIX.length), record])
			const evicted = new Set(planTrackTagEvictions(records, TRACK_TAGS_MAX_RECORDS))
			const loaded: Record<string, TrackTagRecord> = {}

			for (const [uuid, record] of records) {
				if (!evicted.has(uuid)) {
					loaded[uuid] = record
				}
			}

			// Anything written while the read was in flight is newer than what the read returned.
			useTrackTagsStore.setState(state => ({ byUuid: { ...loaded, ...state.byUuid }, hydrated: true }))

			for (const uuid of evicted) {
				void kvDelete(trackTagsKey(uuid)).catch(() => undefined)
			}
		})
		.catch((error: unknown) => {
			log.warn("audio", "failed to load persisted track tags", error)

			if (hydrationEpoch === epoch) {
				useTrackTagsStore.setState({ hydrated: true })
			}
		})

	return hydration
}

export function getTrackTags(uuid: string): TrackTagRecord | undefined {
	return useTrackTagsStore.getState().byUuid[uuid]
}

export function putTrackTags(uuid: string, record: TrackTagRecord): void {
	const elementDuration = elementDurations.get(uuid)
	const merged = record.durationSec === null && elementDuration !== undefined ? { ...record, durationSec: elementDuration } : record

	elementDurations.delete(uuid)
	useTrackTagsStore.setState(state => ({ byUuid: { ...state.byUuid, [uuid]: merged } }))
	persist(uuid, merged)
}

// Another tab may have parsed this track since this tab hydrated; a local kv read is far cheaper than
// parsing it again. Adopts the record into memory when found.
export async function adoptPersistedTrackTags(uuid: string): Promise<TrackTagRecord | null> {
	const record = await kvGetJson(trackTagsKey(uuid), trackTagRecordSchema).catch(() => null)

	if (record !== null && getTrackTags(uuid) === undefined) {
		useTrackTagsStore.setState(state => ({ byUuid: { ...state.byUuid, [uuid]: record } }))
	}

	return record
}

// The media element's duration is authoritative and free; it fills in what the tags could not give
// cheaply (Ogg/Opus, headerless VBR) without ever overriding a tagged duration.
export function backfillTrackDuration(uuid: string, durationSec: number): void {
	if (!Number.isFinite(durationSec) || durationSec <= 0) {
		return
	}

	const seconds = Math.max(1, Math.round(durationSec))
	const record = getTrackTags(uuid)

	if (record === undefined) {
		elementDurations.set(uuid, seconds)

		return
	}

	if (record.durationSec !== null) {
		return
	}

	const updated = { ...record, durationSec: seconds }

	useTrackTagsStore.setState(state => ({ byUuid: { ...state.byUuid, [uuid]: updated } }))
	persist(uuid, updated)
}

// Logout: memory only; the kv rows go with the kv wipe itself.
export function resetTrackTags(): void {
	epoch++
	hydration = null
	elementDurations.clear()
	useTrackTagsStore.setState({ byUuid: {}, hydrated: false })
}
