import { type } from "arktype"
import { MAX_NFO_CHARS, parseNfo } from "@filen/shared/videos"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
import { log } from "@/lib/log"
import { kvDelete, kvEntriesJson, kvGetJson, kvKeys, kvSetJson } from "@/lib/storage/adapter"
import { RecordStore } from "@/features/videos/lib/recordStore.logic"
import { NFO_KV_PREFIX } from "@/features/videos/lib/cacheKeys.logic"
import { videoLibrary } from "@/features/videos/lib/index"
import type { VideoFileRef } from "@/workers/videoIndex/view.logic"

// The `.nfo` beside a title or episode, read on the detail page only: one download per file, the few fields the
// page shows kept in kv by the file's uuid (a content change rotates it), so it is never read twice.

const NFO_MAX_RECORDS = 5_000
// An NFO is a few KiB; the parser reads 256 KiB at most, and a larger file isn't downloaded at all.
export const NFO_MAX_BYTES = MAX_NFO_CHARS
const MAX_CAST = 24

const nfoSummarySchema = type({
	"plot?": "string",
	"tagline?": "string",
	"runtimeMinutes?": "number",
	"mpaa?": "string",
	genres: "string[]",
	cast: "string[]"
})

export type NfoSummary = typeof nfoSummarySchema.infer

const nfoRecordSchema = type({
	nfo: nfoSummarySchema.or("null"),
	at: "number"
})

export const nfoRecords = new RecordStore({
	prefix: NFO_KV_PREFIX,
	schema: nfoRecordSchema,
	maxRecords: NFO_MAX_RECORDS,
	memoryRecords: 256,
	writesPerSweep: 512,
	scope: "videos",
	kv: { kvGetJson, kvSetJson, kvKeys, kvEntriesJson, kvDelete }
})

export function summarizeNfo(text: string): NfoSummary | null {
	const nfo = parseNfo(text)

	if (nfo === null) {
		return null
	}

	return {
		...(nfo.plot === undefined ? {} : { plot: nfo.plot }),
		...(nfo.tagline === undefined ? {} : { tagline: nfo.tagline }),
		...(nfo.runtimeMinutes === undefined ? {} : { runtimeMinutes: nfo.runtimeMinutes }),
		...(nfo.mpaa === undefined ? {} : { mpaa: nfo.mpaa }),
		genres: nfo.genres,
		cast: nfo.cast.slice(0, MAX_CAST)
	}
}

const reads = new Map<string, Promise<NfoSummary | null>>()

async function download(ref: VideoFileRef): Promise<NfoSummary | null> {
	// Too large by the index's own size: refused before anything is asked of the worker or the network.
	if (ref.size > NFO_MAX_BYTES) {
		nfoRecords.put(ref.uuid, { nfo: null, at: Date.now() })

		return null
	}

	const [file] = await videoLibrary.playableFiles([ref.stableUuid])

	if (file?.uuid !== ref.uuid) {
		return null
	}

	const summary =
		Number(file.size) > NFO_MAX_BYTES
			? null
			: summarizeNfo(new TextDecoder().decode(await runOp(sdkApi.downloadFileBytes(file, crypto.randomUUID()))))

	nfoRecords.put(ref.uuid, { nfo: summary, at: Date.now() })

	return summary
}

// The NFO's summary: from kv when read before, else one download (shared by every caller meanwhile). null for a file
// that isn't an NFO the parser knows, or one that is gone; a failed read is tried again next time.
export async function readNfo(ref: VideoFileRef): Promise<NfoSummary | null> {
	const known = await nfoRecords.get(ref.uuid)

	if (known !== null) {
		return known.nfo
	}

	let read = reads.get(ref.uuid)

	if (read === undefined) {
		read = download(ref)
			.catch((e: unknown) => {
				log.warn("videos.nfo", "nfo read failed", e)

				throw e
			})
			.finally(() => {
				reads.delete(ref.uuid)
			})
		reads.set(ref.uuid, read)
	}

	return read
}

export function resetNfoReader(): void {
	reads.clear()
	nfoRecords.reset()
}
