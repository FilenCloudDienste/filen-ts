import { kvDelete, kvDeleteIfAt, kvEntriesJsonInSlices, kvGetJson, kvKeys, kvSetJson } from "@/lib/storage/adapter"
import { RecordStore, type RecordStoreKv, type StoredRecord } from "@/features/videos/lib/recordStore.logic"
import { PROBE_KV_PREFIX, PROBE_MAX_RECORDS, probeRecordSchema } from "@/features/videos/lib/probeService.logic"
import { ART_KV_PREFIX, ART_MAX_RECORDS, artRecordSchema } from "@/features/videos/lib/artwork.logic"
import { FRAME_HINT_KV_PREFIX, FRAME_HINT_MAX_RECORDS, frameHintSchema } from "@/features/videos/lib/frames.logic"

// The Videos feature's per-file kv records, one store per kind.

// A sweep over a full store reads its rows a page at a time and decodes them in slices.
const kv: RecordStoreKv = {
	kvGetJson,
	kvSetJson,
	kvKeys,
	kvEntriesJson: (prefix, schema) => kvEntriesJsonInSlices(prefix, schema),
	kvDelete,
	kvDeleteIfAt: entries => kvDeleteIfAt(entries)
}

// About a thousand writes between two checks of a store's record count.
const WRITES_PER_SWEEP = 1024

// Each kind's options but its kv: the drive's stores and a public link's memory-only ones are the same stores.
const PROBE_OPTIONS = {
	prefix: PROBE_KV_PREFIX,
	schema: probeRecordSchema,
	maxRecords: PROBE_MAX_RECORDS,
	memoryRecords: 1024,
	writesPerSweep: WRITES_PER_SWEEP,
	scope: "videos"
}

const FRAME_HINT_OPTIONS = {
	prefix: FRAME_HINT_KV_PREFIX,
	schema: frameHintSchema,
	maxRecords: FRAME_HINT_MAX_RECORDS,
	memoryRecords: 256,
	writesPerSweep: WRITES_PER_SWEEP,
	scope: "videos"
}

export const probeRecords = new RecordStore({ ...PROBE_OPTIONS, kv })

export const artRecords = new RecordStore({
	prefix: ART_KV_PREFIX,
	schema: artRecordSchema,
	maxRecords: ART_MAX_RECORDS,
	memoryRecords: 1024,
	writesPerSweep: WRITES_PER_SWEEP,
	scope: "videos",
	kv
})

export const frameHints = new RecordStore({ ...FRAME_HINT_OPTIONS, kv })

// Nothing on disk: what a store over it holds lives in the tab's memory alone. The prefix still names a record's
// key in memory.
const NO_KV: RecordStoreKv = {
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvKeys: () => Promise.resolve([]),
	kvEntriesJson: () => Promise.resolve([]),
	kvDelete: () => Promise.resolve()
}

function memoryOnly<T extends StoredRecord>(store: RecordStore<T>): RecordStore<T> {
	store.hold()

	return store
}

// A public link's keyframe reads keep their probes and frame hints for the tab only: what a visitor's reads said
// about someone else's files is never written to kv, nor read from what the drive kept there.
export const linkProbeRecords = memoryOnly(new RecordStore({ ...PROBE_OPTIONS, kv: NO_KV }))

export const linkFrameHints = memoryOnly(new RecordStore({ ...FRAME_HINT_OPTIONS, kv: NO_KV }))
