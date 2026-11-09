import { type } from "arktype"
import { MAX_SUBTITLE_CHARS, decodeSubtitleBytes, parseEdl, parseSubtitle, type CueStore, type SkipSegment } from "@filen/shared/videos"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
import { kvGetJson, kvSetJson } from "@/lib/storage/adapter"
import { log } from "@/lib/log"
import { SUBTITLE_ENCODING_KV_PREFIX } from "@/features/videos/lib/cacheKeys.logic"
import { videoLibrary } from "@/features/videos/lib/index"
import { parseFormatOf, type PlayerSubtitleTrack } from "@/features/videos/lib/player/subtitles.logic"
import type { VideoFileRef } from "@/workers/videoIndex/view.logic"

// Reads a player's small sidecars: a chosen subtitle file (one read, refused over 8 MiB) and the .edl. The latest
// few results are kept, so switching back and forth on an item costs nothing while a long binge holds no more than
// the last items' files. A subtitle file's encoding chosen by hand is remembered per file on this device.

const MAX_EDL_BYTES = 256 * 1024
// Subtitle files whose bytes are kept (the item's, one back), decoded stores kept, and parsed .edl files kept.
export const MAX_KEPT_SUBTITLE_FILES = 2
export const MAX_KEPT_DECODED = 2
const MAX_KEPT_EDLS = 4

// A small least-recently-used cache over a Map's insertion order.
function recall<V>(map: Map<string, V>, key: string): V | undefined {
	const value = map.get(key)

	if (value !== undefined) {
		map.delete(key)
		map.set(key, value)
	}

	return value
}

function keep<V>(map: Map<string, V>, key: string, value: V, max: number): void {
	map.delete(key)
	map.set(key, value)

	while (map.size > max) {
		const oldest = map.keys().next()

		if (oldest.done === true) {
			break
		}

		map.delete(oldest.value)
	}
}

export type SubtitleLoad =
	{ status: "ok"; cues: CueStore; encoding: string; confident: boolean } | { status: "tooLarge" | "unreadable" | "unavailable" }

function encodingKey(uuid: string): string {
	return `${SUBTITLE_ENCODING_KV_PREFIX}${uuid}`
}

export function readSubtitleEncoding(uuid: string): Promise<string | null> {
	return kvGetJson(encodingKey(uuid), type("string")).catch(() => null)
}

export function saveSubtitleEncoding(uuid: string, encoding: string | null): void {
	kvSetJson(encodingKey(uuid), encoding ?? "").catch((error: unknown) => {
		log.warn("videos.player", "subtitle encoding not saved", error)
	})
}

type ByteRead = { status: "ok"; bytes: Uint8Array } | { status: "tooLarge" | "unavailable" }

// The file as the drive has it now (its size, not the one the index recorded), read whole when it fits.
async function readBytes(ref: VideoFileRef, token: string, maxBytes: number): Promise<ByteRead> {
	const [file] = await videoLibrary.playableFiles([ref.stableUuid])

	if (file === undefined) {
		return { status: "unavailable" }
	}

	if (Number(file.size) > maxBytes) {
		return { status: "tooLarge" }
	}

	return { status: "ok", bytes: await runOp(sdkApi.downloadFileBytes(file, token)) }
}

// Reads a player's small sidecars once each and keeps a subtitle file's bytes while it is among the latest: it is
// decoded again per encoding picked, not downloaded again.
export class SidecarReader {
	private readonly bytes = new Map<string, Promise<ByteRead>>()
	private readonly decoded = new Map<string, SubtitleLoad>()
	private readonly edls = new Map<string, Promise<SkipSegment[]>>()
	private readonly tokens = new Set<string>()

	// `encoding` null: detect (BOM, strict UTF-8, then the language's legacy codepage).
	public async subtitle(track: PlayerSubtitleTrack, encoding: string | null): Promise<SubtitleLoad> {
		const file = track.file
		const format = track.format === null ? null : parseFormatOf(track.format)

		if (file === null || format === null) {
			return { status: "unavailable" }
		}

		const key = `${file.uuid}:${encoding ?? ""}`
		const known = recall(this.decoded, key)

		if (known !== undefined) {
			return known
		}

		const read = await this.read(file, MAX_SUBTITLE_CHARS, true)

		if (read.status !== "ok") {
			return { status: read.status }
		}

		const text = decodeSubtitleBytes(read.bytes, { languageHint: track.lang, encoding })
		const cues = text === null ? null : parseSubtitle(text.text, format)
		const result: SubtitleLoad =
			text === null
				? { status: "tooLarge" }
				: cues === null || cues.texts.length === 0
					? { status: "unreadable" }
					: { status: "ok", cues, encoding: text.encoding, confident: text.confident }

		keep(this.decoded, key, result, MAX_KEPT_DECODED)

		return result
	}

	// A Kodi .edl's skips; empty when there is none or it can't be read.
	public edl(file: VideoFileRef | null): Promise<SkipSegment[]> {
		if (file === null) {
			return Promise.resolve([])
		}

		let load = recall(this.edls, file.uuid)

		if (load === undefined) {
			load = this.read(file, MAX_EDL_BYTES, false).then(read =>
				read.status === "ok" ? parseEdl(new TextDecoder().decode(read.bytes)) : []
			)
			keep(this.edls, file.uuid, load, MAX_KEPT_EDLS)
		}

		return load
	}

	// Stops reads still under way; what was read stays kept.
	public cancel(): void {
		for (const token of this.tokens) {
			void sdkApi.cancelPreviewDownload(token)
		}

		this.tokens.clear()
	}

	// One download per file while it is kept (`keepBytes`: a subtitle file, decoded again per encoding; an .edl is
	// kept parsed instead); a failed one is tried again next time.
	private read(file: VideoFileRef, maxBytes: number, keepBytes: boolean): Promise<ByteRead> {
		let read = recall(this.bytes, file.uuid)

		if (read === undefined) {
			const token = crypto.randomUUID()

			this.tokens.add(token)

			const pending: Promise<ByteRead> = readBytes(file, token, maxBytes)
				.catch((error: unknown): ByteRead => {
					log.warn("videos.player", "sidecar read failed", error)

					return { status: "unavailable" }
				})
				.then(result => {
					this.tokens.delete(token)

					if (result.status === "unavailable" && this.bytes.get(file.uuid) === pending) {
						this.bytes.delete(file.uuid)
					}

					return result
				})

			if (keepBytes) {
				keep(this.bytes, file.uuid, pending, MAX_KEPT_SUBTITLE_FILES)
			}

			read = pending
		}

		return read
	}
}
