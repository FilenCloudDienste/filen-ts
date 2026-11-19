import * as Comlink from "comlink"
import type { AnyFile } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { log } from "@/lib/log"
import { readThumbnailBlob } from "@/features/drive/lib/thumbCache"
import { readStoreBlob } from "@/lib/storage/opfsBlobStore"
import { rangeReads, type RangeReadBudget } from "@/lib/media/rangeReads"
import { SAMPLE_HEIGHT, SAMPLE_WIDTH, fitMode, isDark, sampleOf, type FrameSample, type Rgb, type Size } from "@/lib/media/framePick.logic"
import { RankedGate } from "@/features/drive/lib/rankedGate"
import { onAbort } from "@/lib/abort"
import { SharedWork } from "@/lib/sharedWork"
import type { SdkThumbnailResult } from "@/workers/sdk.worker"
import type { RecordStore } from "@/features/videos/lib/recordStore.logic"
import { artRecords } from "@/features/videos/lib/records"
import { ART_STORE, artKey, type ArtSlotCode } from "@/features/videos/lib/artStore.logic"
import { probeService, type ProbeService } from "@/features/videos/lib/probeService"
import { PROBE_REVISION } from "@/features/videos/lib/probeService.logic"
import { frameGenerator, type FrameGenerator, type GeneratedFrame } from "@/features/videos/lib/frames"
import {
	ART_CONCURRENCY,
	ART_LOSSY_QUALITY,
	ART_SOURCE_MAX_BYTES,
	artBox,
	probeLandscapeCover,
	titleColour,
	type ArtCandidate,
	type ArtRecord,
	type ArtSource
} from "@/features/videos/lib/artwork.logic"

// Loads a slot's artwork from its candidates (artCandidates), best first: a stored image when one exists
// (a local read), else the first candidate that yields one. Sidecar images and embedded covers are
// decoded by the SDK into a small WebP, so an original never reaches an <img>; the drive's own
// thumbnail is reused as it is; a frame is generated only as a last resort. Every image made is stored
// with its metadata, so each costs its reads once per content version.

// A failed image source for one file is left alone for the session after this many tries.
const ART_FAILURE_LIMIT = 3

// A file the scan listed, as the loaders need it.
export interface ArtFile {
	uuid: string
	size: number
	file: AnyFile
}

export interface ArtLoadRequest {
	candidates: readonly ArtCandidate[]
	slot: ArtSlotCode
	// For the typographic card, and the colour of the synthetic fallbacks.
	title: string
	// The file behind a candidate's index; null when the listing no longer has it. May resolve asynchronously (the
	// library index rebuilds playable files in its worker on request).
	resolveFile: (file: number) => ArtFile | null | Promise<ArtFile | null>
	signal?: AbortSignal
	rank?: () => number
}

export type ArtResult =
	| { type: "image"; blob: Blob; source: ArtSource; width: number; height: number; fit: "cover" | "contain"; dominant: Rgb | null }
	| { type: "typographic"; title: string; colour: Rgb }
	| { type: "gradient"; colour: Rgb }

export interface ArtLoaderDeps {
	// An image file, or a byte range of one (an embedded cover), made into the slot's size; cancelled
	// through `token`, even before it starts.
	makeArt: (file: AnyFile, range: ByteSpan, box: Size, token: string) => Promise<SdkThumbnailResult | { type: "notImage" }>
	cancel: (token: string) => void
	storeArt: (key: string, bytes: Uint8Array) => Promise<void>
	readArt: (key: string) => Promise<Blob | null>
	readDriveThumb: (uuid: string) => Promise<Blob | null>
	sampleImage: (blob: Blob) => Promise<FrameSample | null>
	measureImage: (blob: Blob) => Promise<MeasuredImage | null>
	probes: Pick<ProbeService, "request">
	frames: Pick<FrameGenerator, "generate" | "settledMiss">
	records: RecordStore<ArtRecord>
	reads: Pick<RangeReadBudget, "run">
	devicePixelRatio: () => number
	now: () => number
}

type ImageResult = Extract<ArtResult, { type: "image" }>

export interface ByteSpan {
	offset: number
	size: number
}

interface SourceContext {
	signal: AbortSignal
	rank: () => number
}

type StoredSource = "sidecar" | "embedded" | "frame"

export interface MeasuredImage {
	width: number
	height: number
	sample: FrameSample
}

// Lets visible slots claim a free permit before ones further down the queue.
const ART_HOLD_MS = 50

export class ArtLoader {
	private readonly deps: ArtLoaderDeps
	private readonly gate = new RankedGate(ART_CONCURRENCY, ART_HOLD_MS)
	private readonly shared = new SharedWork<ImageResult | null>()
	private readonly failures = new Map<string, number>()
	// Sources that answered for good: not an image, a format the decoder refuses.
	private readonly unavailable = new Set<string>()
	// The drive thumbnail's size, colour and darkness, measured once per session.
	private readonly driveThumbs = new Map<string, MeasuredImage | null>()
	// Bumped by reset: work started before it stores nothing.
	private epoch = 0
	// Tokens of the decodes running, cancelled by reset.
	private readonly running = new Set<string>()

	public constructor(deps: ArtLoaderDeps) {
		this.deps = deps
	}

	// Null only when `signal` aborted first.
	public async load(request: ArtLoadRequest): Promise<ArtResult | null> {
		// A function, so each check reads the signal anew across the awaits.
		const aborted = (): boolean => request.signal?.aborted === true

		for (const candidate of request.candidates) {
			if (aborted()) {
				return null
			}

			if (candidate.source === "typographic") {
				return { type: "typographic", title: request.title, colour: titleColour(request.title) }
			}

			if (candidate.source === "gradient") {
				return { type: "gradient", colour: titleColour(request.title) }
			}

			const file = await request.resolveFile(candidate.file)

			if (aborted()) {
				return null
			}

			if (file === null) {
				continue
			}

			try {
				const { source } = candidate
				const image = await this.shared.run(
					`${source}:${file.uuid}:${request.slot}`,
					{ signal: request.signal, rank: request.rank },
					context => this.fromSource(source, file, request.slot, context)
				)

				if (image !== null) {
					return image
				}
			} catch (error) {
				if (!aborted()) {
					log.warn("videos", "artwork load failed", candidate.source, file.uuid, error)
					this.noteFailure(candidate.source, file.uuid)
				}
			}
		}

		return aborted() ? null : { type: "gradient", colour: titleColour(request.title) }
	}

	// What costs no download: an image stored earlier, or the drive's cached thumbnail, in candidate order. "network" as
	// soon as a candidate would need reads before anything local of higher precedence was found (load() then tries
	// it); null only when `signal` aborted first. Files are named by `fileUuid` alone: nothing keyed is resolved here.
	public async loadLocal(request: ArtLoadRequest & { fileUuid: (file: number) => string | null }): Promise<ArtResult | "network" | null> {
		const aborted = (): boolean => request.signal?.aborted === true

		for (const candidate of request.candidates) {
			if (aborted()) {
				return null
			}

			if (candidate.source === "typographic") {
				return { type: "typographic", title: request.title, colour: titleColour(request.title) }
			}

			if (candidate.source === "gradient") {
				return { type: "gradient", colour: titleColour(request.title) }
			}

			const uuid = request.fileUuid(candidate.file)

			if (uuid === null || this.skipped(candidate.source, uuid)) {
				continue
			}

			try {
				if (candidate.source === "driveThumb") {
					const image = await this.fromDriveThumb(uuid, request.slot)

					if (image !== null) {
						return aborted() ? null : image
					}

					continue
				}

				const stored = await this.stored(candidate.source, uuid, request.slot)

				if (aborted()) {
					return null
				}

				if (stored === null) {
					return "network"
				}

				if (stored !== "miss") {
					return stored
				}
			} catch (error) {
				log.warn("videos", "local artwork read failed", candidate.source, uuid, error)

				return "network"
			}
		}

		return aborted() ? null : { type: "gradient", colour: titleColour(request.title) }
	}

	private sourceKey(source: ArtSource, uuid: string): string {
		return `${source}:${uuid}`
	}

	private noteFailure(source: ArtSource, uuid: string): void {
		const key = this.sourceKey(source, uuid)

		this.failures.set(key, (this.failures.get(key) ?? 0) + 1)
	}

	private skipped(source: ArtSource, uuid: string): boolean {
		const key = this.sourceKey(source, uuid)

		return this.unavailable.has(key) || (this.failures.get(key) ?? 0) >= ART_FAILURE_LIMIT
	}

	// The stored image for this source and slot, when one exists (a local read); a settled miss when the
	// source answered for good that it has none.
	private async stored(source: StoredSource, uuid: string, slot: ArtSlotCode): Promise<ImageResult | "miss" | null> {
		// A frame the player captured stands in for a generated one.
		const keys = source === "frame" ? [artKey(uuid, slot, "capture"), artKey(uuid, slot, "frame")] : [artKey(uuid, slot)]

		for (const key of keys) {
			const record = await this.deps.records.get(key)

			if (record === null || (record.source !== source && record.source !== "capture")) {
				continue
			}

			if (record.miss === true) {
				// A no-cover verdict of an older probe revision: its probe reads the covers again.
				if (record.rev !== undefined && record.rev < PROBE_REVISION) {
					continue
				}

				return "miss"
			}

			const blob = await this.deps.readArt(key).catch(() => null)

			if (blob !== null && blob.size > 0) {
				return { type: "image", blob, source, width: record.w, height: record.h, fit: record.fit, dominant: record.dom }
			}
		}

		// The frame generator's own lasting verdict (its hint): no frame can be made of the file.
		if (source === "frame" && (await this.deps.frames.settledMiss(uuid))) {
			return "miss"
		}

		return null
	}

	private async fromSource(
		source: Exclude<ArtSource, "typographic" | "gradient">,
		file: ArtFile,
		slot: ArtSlotCode,
		context: SourceContext
	): Promise<ImageResult | null> {
		if (source === "driveThumb") {
			return this.fromDriveThumb(file.uuid, slot)
		}

		const epoch = this.epoch
		// A function, so each check reads the signal anew across the awaits.
		const dropped = (): boolean => context.signal.aborted
		const stored = await this.stored(source, file.uuid, slot)

		if (stored !== null || this.skipped(source, file.uuid) || dropped()) {
			return stored === "miss" ? null : stored
		}

		const box = artBox(slot, this.deps.devicePixelRatio())
		const probeOptions = { rank: context.rank, signal: context.signal }

		if (source === "sidecar") {
			if (file.size > ART_SOURCE_MAX_BYTES) {
				// Too large for every slot, for as long as the file (its uuid) lasts.
				this.settle(source, file.uuid, slot, epoch)

				return null
			}

			return this.makeArt(source, file, { offset: 0, size: file.size }, slot, box, context, epoch)
		}

		if (source === "embedded") {
			const record = await this.deps.probes.request({ uuid: file.uuid, file: file.file }, "cover", probeOptions)
			// A backdrop comes from the landscape cover, a poster or still from the front one.
			const cover = slot === "b" ? probeLandscapeCover(record?.probe) : (record?.probe?.cover ?? null)

			if (cover !== null && cover.size <= ART_SOURCE_MAX_BYTES) {
				return this.makeArt(source, file, cover, slot, box, context, epoch)
			}

			// Only a probe that read the file answers for good (no record: offline, a failed or dropped probe). Kept for
			// this slot only (a poster's miss leaves the backdrop's landscape cover alone), stamped with the probe
			// revision, so a newer one asks again.
			if ((record?.probe ?? null) !== null && !dropped() && this.persisting(epoch)) {
				this.deps.records.put(artKey(file.uuid, slot), {
					slot,
					source,
					fit: "contain",
					w: 0,
					h: 0,
					dom: [0, 0, 0],
					miss: true,
					rev: PROBE_REVISION,
					at: this.deps.now()
				})
			}

			return null
		}

		const record = await this.deps.probes.request({ uuid: file.uuid, file: file.file }, "card", probeOptions)
		const probe = record?.probe ?? null

		if (probe === null || dropped()) {
			return null
		}

		const frame = await this.deps.frames.generate({
			target: { uuid: file.uuid, file: file.file, size: file.size },
			probe,
			box,
			rank: context.rank,
			signal: context.signal
		})

		return frame === null ? null : this.persist(frame, "frame", file.uuid, slot, box, epoch)
	}

	// A sidecar or an embedded cover through the SDK's decoder, in an art slot and a shared read permit.
	// The cancel is registered first: the worker remembers a token cancelled before its read starts.
	private async makeArt(
		source: "sidecar" | "embedded",
		file: ArtFile,
		range: ByteSpan,
		slot: ArtSlotCode,
		box: Size,
		context: SourceContext,
		epoch: number
	): Promise<ImageResult | null> {
		const token = crypto.randomUUID()
		const unsubscribe = onAbort(context.signal, () => {
			this.deps.cancel(token)
		})

		this.running.add(token)

		try {
			const made = await this.gate.withPermit(context.rank, () =>
				context.signal.aborted
					? Promise.resolve(null)
					: this.deps.reads.run(context.rank, () =>
							context.signal.aborted ? Promise.resolve(null) : this.deps.makeArt(file.file, range, box, token)
						)
			)

			if (made === null || context.signal.aborted) {
				return null
			}

			if (made.type !== "thumbnail") {
				this.settle(source, file.uuid, slot, epoch)

				return null
			}

			const sample = await this.deps.sampleImage(new Blob([made.bytes as Uint8Array<ArrayBuffer>]))

			return await this.persist(
				{ bytes: made.bytes, width: made.width, height: made.height, dominant: sample?.dominant ?? null },
				source,
				file.uuid,
				slot,
				box,
				epoch
			)
		} finally {
			this.running.delete(token)
			unsubscribe()
		}
	}

	// A source that answered for good it has no image: remembered here and in its record, so neither this
	// session nor a later one reads it again.
	private settle(source: "sidecar" | "embedded", uuid: string, slot: ArtSlotCode, epoch: number): void {
		if (!this.persisting(epoch)) {
			return
		}

		this.unavailable.add(this.sourceKey(source, uuid))
		this.deps.records.put(artKey(uuid, slot), {
			slot,
			source,
			fit: "contain",
			w: 0,
			h: 0,
			dom: [0, 0, 0],
			miss: true,
			at: this.deps.now()
		})
	}

	// Whether work started in `epoch` may still store: no reset and no sign-out since.
	private persisting(epoch: number): boolean {
		return epoch === this.epoch && this.deps.records.writable()
	}

	// Stores the image and its record; the returned Blob is built first, since storing transfers the bytes.
	private async persist(
		image: Omit<GeneratedFrame, "dominant"> & { dominant: Rgb | null },
		source: "sidecar" | "embedded" | "frame",
		uuid: string,
		slot: ArtSlotCode,
		box: Size,
		epoch: number
	): Promise<ImageResult> {
		const blob = new Blob([image.bytes as Uint8Array<ArrayBuffer>])
		const fit = fitMode({ width: image.width, height: image.height }, box)
		const key = artKey(uuid, slot, source === "frame" ? "frame" : "image")

		if (!this.persisting(epoch)) {
			return { type: "image", blob, source, width: image.width, height: image.height, fit, dominant: image.dominant }
		}

		try {
			await this.deps.storeArt(key, image.bytes)
			this.deps.records.put(key, {
				slot,
				source,
				fit,
				w: image.width,
				h: image.height,
				dom: image.dominant ?? [0, 0, 0],
				at: this.deps.now()
			})
		} catch (error) {
			log.warn("videos", "artwork persist failed", key, error)
		}

		return { type: "image", blob, source, width: image.width, height: image.height, fit, dominant: image.dominant }
	}

	// The drive's thumbnail for the video, as it is: a local read, no download. Skipped when black (an
	// older thumbnail of the opening second).
	private async fromDriveThumb(uuid: string, slot: ArtSlotCode): Promise<ImageResult | null> {
		const blob = await this.deps.readDriveThumb(uuid)

		if (blob === null || blob.size === 0) {
			return null
		}

		let measured = this.driveThumbs.get(uuid)

		if (measured === undefined) {
			measured = await this.deps.measureImage(blob)
			this.driveThumbs.set(uuid, measured)
		}

		if (measured === null || isDark(measured.sample.luma)) {
			return null
		}

		const box = artBox(slot, this.deps.devicePixelRatio())

		return {
			type: "image",
			blob,
			source: "driveThumb",
			width: measured.width,
			height: measured.height,
			fit: fitMode(measured, box),
			dominant: measured.sample.dominant
		}
	}

	// Logout: forget every verdict and measurement, and cancel the decodes running; nothing started before stores.
	public reset(): void {
		this.epoch++

		for (const token of this.running) {
			this.deps.cancel(token)
		}

		this.running.clear()
		this.failures.clear()
		this.unavailable.clear()
		this.driveThumbs.clear()
		this.deps.records.reset()
	}
}

function sampleBitmap(bitmap: ImageBitmap): FrameSample | null {
	const canvas = new OffscreenCanvas(SAMPLE_WIDTH, SAMPLE_HEIGHT)
	const context = canvas.getContext("2d", { willReadFrequently: true })

	if (context === null) {
		return null
	}

	context.drawImage(bitmap, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT)

	return sampleOf(context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data)
}

// Colour and darkness of an encoded image whose size is known, decoded straight to the sample's size;
// null when the browser cannot decode it.
export async function sampleImage(blob: Blob): Promise<FrameSample | null> {
	try {
		const bitmap = await createImageBitmap(blob, { resizeWidth: SAMPLE_WIDTH, resizeHeight: SAMPLE_HEIGHT, resizeQuality: "low" })

		try {
			return sampleBitmap(bitmap)
		} finally {
			bitmap.close()
		}
	} catch {
		return null
	}
}

// Size, colour and darkness of a small encoded image (a drive thumbnail, at most a few hundred pixels).
export async function measureImage(blob: Blob): Promise<MeasuredImage | null> {
	try {
		const bitmap = await createImageBitmap(blob)

		try {
			const sample = sampleBitmap(bitmap)

			return sample === null ? null : { width: bitmap.width, height: bitmap.height, sample }
		} finally {
			bitmap.close()
		}
	} catch {
		return null
	}
}

export const artLoader = new ArtLoader({
	makeArt: (file, range, box, token) =>
		sdkApi.makeArtFromRange(file, range, { maxWidth: box.width, maxHeight: box.height, lossyQuality: ART_LOSSY_QUALITY }, token),
	cancel: token => {
		void sdkApi.cancelPreviewDownload(token)
	},
	storeArt: (key, bytes) => sdkApi.storeArt(key, Comlink.transfer(bytes, [bytes.buffer])),
	readArt: key => readStoreBlob(ART_STORE, key),
	readDriveThumb: readThumbnailBlob,
	sampleImage,
	measureImage,
	probes: probeService,
	frames: frameGenerator,
	records: artRecords,
	reads: rangeReads,
	devicePixelRatio: () => window.devicePixelRatio,
	now: () => Date.now()
})

// A frame the player captured on pause or stop (captureFrameFromVideo), stored as the video's still.
export async function storeCapturedFrame(videoUuid: string, slot: ArtSlotCode, frame: GeneratedFrame): Promise<void> {
	if (!artRecords.writable()) {
		return
	}

	const key = artKey(videoUuid, slot, "capture")

	await sdkApi.storeArt(key, Comlink.transfer(frame.bytes, [frame.bytes.buffer]))
	artRecords.put(key, {
		slot,
		source: "capture",
		fit: fitMode({ width: frame.width, height: frame.height }, artBox(slot, window.devicePixelRatio)),
		w: frame.width,
		h: frame.height,
		dom: frame.dominant,
		at: Date.now()
	})
}
