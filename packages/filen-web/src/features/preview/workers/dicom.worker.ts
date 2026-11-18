/// <reference lib="webworker" />
import * as Comlink from "comlink"
import { SyncRangeReader } from "@filen/office/dom/pdfedit"
import { RANGE_READ_TIMEOUT_MS } from "@/lib/media/rangePort"
import {
	DicomOpenError,
	fileHeld,
	memorySource,
	rangeSource,
	readHeader,
	type DicomHeader,
	type DicomSource
} from "@/features/preview/lib/dicom/dicomFile"
import { imageVerdict, readPixelModule, type PixelModule } from "@/features/preview/lib/dicom/pixelModule"
import {
	DicomFrameFailure,
	encapsulatedFrame,
	fragmentIndex,
	nativeFrame,
	type FrameContext
} from "@/features/preview/lib/dicom/frameDecode"
import { FrameCache } from "@/features/preview/lib/dicom/frameCache.logic"
import { codecHeap, decodeCompressed, releaseCodec } from "@/features/preview/lib/dicom/codecs"
import { releasesHeap } from "@/features/preview/lib/dicom/budget.logic"
import { DICOM_FRAME_CACHE_BYTES, type DicomDecoder } from "@/features/preview/lib/dicom/transferSyntax"
import {
	drawnSize,
	grayLut,
	lutFits,
	modalityRange,
	rangeWindow,
	renderColor,
	renderGray,
	renderPalette,
	type FrameSamples,
	type GrayModel,
	type Window
} from "@/features/preview/lib/dicom/pixels.logic"
import { FITTED, dragWindow, panBy, placement, wheelFactor, windowStep, zoomAt, type View } from "@/features/preview/lib/dicom/view.logic"
import { tagLevel, tagValue, textOf } from "@/features/preview/lib/dicom/tagTree"
import type { DicomText } from "@/features/preview/lib/dicom/charset.logic"
import type { FragmentIndex } from "@/features/preview/lib/dicom/frames.logic"
import type {
	DicomBudget,
	DicomFrameOutcome,
	DicomInfo,
	DicomOpenResult,
	DicomOpenSource,
	DicomStatus,
	DicomTagLevel,
	FrameFailure
} from "@/features/preview/lib/dicom/protocol"
import {
	MAX_BACKING_SIDE,
	type CanvasInput,
	type ShellToWorker,
	type WorkerToShell
} from "@/features/preview/components/canvasViewerShell.logic"

// One DICOM file, owned by its viewer and terminated with it: its header parsed from a growing prefix (a drive or link
// file through the sync range bridge, anything else whole), its frames decoded on demand under the pixel budget, and
// drawn into the shell's OffscreenCanvas (2D) through the window, only when something changed. Nothing about the
// file's values is logged.

const DECODERS: ReadonlySet<DicomDecoder> = new Set(["native", "rle", "jpegBaseline", "jpegLossless", "jpegLs", "jpeg2000", "htj2k"])
// Playback when the file names no frame time.
const DEFAULT_FRAME_MS = 100
const KEY_ZOOM = 1.25
const KEY_PAN = 64

interface Opened {
	readonly header: DicomHeader
	readonly module: PixelModule
	readonly context: FrameContext | null
	readonly fragments: FragmentIndex | null
	readonly model: GrayModel
	readonly info: DicomInfo
	readonly text: DicomText
}

let opened: Opened | null = null
const cache = new FrameCache<FrameSamples>(DICOM_FRAME_CACHE_BYTES)
let samples: FrameSamples | null = null
let current = 0
let failure: FrameFailure | null = null
// The window in effect; null until the first frame sets the default.
let voiWindow: Window | null = null
let baseWindow: Window | null = null
let invert = false
let view: View = FITTED
// Built from the samples when they, the window or Invert change.
let image: { canvas: OffscreenCanvas; context: OffscreenCanvasRenderingContext2D; data: ImageData } | null = null
let imageStale = true
let lut: { window: Window; invert: boolean; table: Uint8Array } | null = null
let canvas: OffscreenCanvas | null = null
let context: OffscreenCanvasRenderingContext2D | null = null
let shell: MessagePort | null = null
let width = 1
let height = 1
let frame: number | null = null
let posted = ""
// The latest show() asked for: an older one finishing late does not replace it.
let requested = 0
// Playback: on until paused; it waits while the document is hidden.
let playing = false
let hidden = false
let tick: number | null = null
let lastStep = 0
const pointers = new Map<number, { x: number; y: number; buttons: number; pointerType: string }>()

// The worker's decode budget (workerDecodeBytes): sent with the file, and again when the device profile is refined.
let decodeBytes = 0

// Everything shown of the file before: a second open starts from nothing, as the first did.
function forgetFile(): void {
	setPlaying(false)
	opened = null
	cache.clear()
	requested++
	samples = null
	current = 0
	failure = null
	voiWindow = null
	baseWindow = null
	invert = false
	view = FITTED
	image = null
	imageStale = true
	lut = null
	posted = ""
	pointers.clear()
}

// The decoded frames held while another decodes: those kept, and the one on screen when it is not among them.
function framesHeld(): number {
	return cache.bytes + (samples !== null && !cache.has(current) ? samples.data.byteLength : 0)
}

function send(message: WorkerToShell<DicomStatus>): void {
	shell?.postMessage(message)
}

// The status post waiting for the next animation frame: however many changes come in one (a cine step, a drag of the
// window, a toggle), the page hears of them once a frame.
let statusFrame: number | null = null

function postStatus(): void {
	statusFrame ??= requestAnimationFrame(() => {
		statusFrame = null
		sendStatus()
	})
}

function sendStatus(): void {
	const status: DicomStatus = {
		frame: current,
		window: voiWindow,
		atDefault: voiWindow === baseWindow,
		playing,
		failure,
		reduced: samples !== null && opened !== null && samples.rows < opened.module.rows
	}
	const key = JSON.stringify(status)

	if (key !== posted) {
		posted = key
		send({ type: "status", status })
	}
}

function schedule(): void {
	frame ??= requestAnimationFrame(() => {
		frame = null
		paint()
	})
}

// One playback step a frame time after the last: the next frame (looping), then the one after it decoded while this
// one is on screen, before the step after is timed, so a slow decode slows playback rather than queueing frames.
function playStep(now: number): void {
	tick = null

	const state = opened

	if (!playing || hidden || state === null) return

	if (now - lastStep < state.info.frameTimeMs) {
		tick = requestAnimationFrame(playStep)

		return
	}

	lastStep = now

	const next = (current + 1) % state.info.frames

	void showFrame(next)
		.then(async () => {
			await prefetch(state, (next + 1) % state.info.frames)
		})
		.then(() => {
			if (playing && !hidden && tick === null) tick = requestAnimationFrame(playStep)
		})
}

function setPlaying(on: boolean): void {
	const state = opened

	playing = on && state !== null && state.info.frames > 1

	if (playing && !hidden && tick === null) {
		lastStep = performance.now()
		tick = requestAnimationFrame(playStep)
	}

	if (!playing && tick !== null) {
		cancelAnimationFrame(tick)
		tick = null
	}

	postStatus()
}

function rangedSource(source: Extract<DicomOpenSource, { kind: "ranged" }>): DicomSource {
	const { channel } = source
	const reader = new SyncRangeReader(channel.buffer, channel.port, channel.length, {
		deadlineMs: RANGE_READ_TIMEOUT_MS,
		now: () => performance.now()
	})

	return rangeSource(channel.length, (out, offset) => reader.read(out, 0, out.length, offset))
}

function grayModel(module: PixelModule): GrayModel {
	return {
		bitsStored: module.bitsStored,
		signed: module.signed,
		slope: module.slope,
		intercept: module.intercept,
		voiFunction: module.voiFunction,
		inverted: module.photometric === "MONOCHROME1"
	}
}

function rebuildImage(): void {
	const shown = samples
	const state = opened

	if (shown === null || state === null || voiWindow === null) return

	const drawn = drawnSize(shown, MAX_BACKING_SIDE)

	if (image?.data.width !== drawn.width || image.data.height !== drawn.height) {
		const offscreen = new OffscreenCanvas(drawn.width, drawn.height)
		const drawing = offscreen.getContext("2d")

		if (drawing === null) return

		image = { canvas: offscreen, context: drawing, data: new ImageData(drawn.width, drawn.height) }
	}

	const out = image.data.data

	switch (shown.color) {
		case "gray": {
			const fits = lutFits(state.model)

			if (fits && (lut?.window !== voiWindow || lut.invert !== invert)) {
				lut = { window: voiWindow, invert, table: grayLut(state.model, voiWindow, invert) }
			}

			renderGray(shown, state.model, voiWindow, invert, fits ? (lut?.table ?? null) : null, drawn, out)
			break
		}
		case "palette": {
			if (state.module.palette !== null)
				renderPalette(shown, state.module.bitsStored, state.module.signed, state.module.palette, invert, drawn, out)
			break
		}
		default:
			renderColor(shown, state.module.bitsStored, invert, drawn, out)
	}

	image.context.putImageData(image.data, 0, 0)
	imageStale = false
}

function paint(): void {
	const target = context
	const state = opened

	if (target === null || state === null) return

	target.setTransform(1, 0, 0, 1, 0, 0)
	target.clearRect(0, 0, width, height)

	if (failure !== null || samples === null) {
		postStatus()

		return
	}

	if (imageStale) rebuildImage()

	if (image !== null) {
		const box = placement({ width, height }, { width: samples.columns, height: samples.rows }, state.module.pixelAspect, view)

		target.imageSmoothingEnabled = box.width < samples.columns
		target.imageSmoothingQuality = "high"
		target.drawImage(image.canvas, box.x, box.y, box.width, box.height)
	}

	postStatus()
}

function changeWindow(next: Window | null): void {
	voiWindow = next ?? baseWindow
	imageStale = true
	schedule()
}

function input(events: readonly CanvasInput[]): void {
	const state = opened

	if (state === null || samples === null) return

	let nextView = view
	let nextWindow = voiWindow

	for (const event of events) {
		switch (event.type) {
			case "pointer": {
				const previous = pointers.get(event.id)

				if (event.phase === "down") {
					pointers.set(event.id, { x: event.x, y: event.y, buttons: event.buttons, pointerType: event.pointerType })
				} else if (event.phase === "move" && previous !== undefined) {
					const dx = event.x - previous.x
					const dy = event.y - previous.y

					if (pointers.size > 1) {
						// Two fingers: zoom by the change in their distance, about their midpoint.
						const other = [...pointers.entries()].find(([id]) => id !== event.id)?.[1]

						if (other !== undefined) {
							const before = Math.hypot(previous.x - other.x, previous.y - other.y)
							const after = Math.hypot(event.x - other.x, event.y - other.y)

							if (before > 0)
								nextView = zoomAt(
									nextView,
									after / before,
									{ width, height },
									(event.x + other.x) / 2,
									(event.y + other.y) / 2
								)
						}
					} else if (
						previous.pointerType === "mouse" &&
						previous.buttons === 1 &&
						state.info.windowed &&
						nextWindow !== null &&
						baseWindow !== null
					) {
						// The primary button sets the window, as in every DICOM viewer; the others, and a finger, pan.
						nextWindow = dragWindow(nextWindow, dx, dy, windowStep(baseWindow))
					} else {
						nextView = panBy(nextView, dx, dy)
					}

					pointers.set(event.id, { ...previous, x: event.x, y: event.y })
				} else if (event.phase === "up" || event.phase === "cancel") {
					pointers.delete(event.id)
				}

				break
			}
			case "wheel":
				nextView = zoomAt(nextView, wheelFactor(event.deltaY), { width, height }, event.x, event.y)
				break
			case "key":
				if (event.phase !== "down") break

				switch (event.key) {
					case "+":
					case "=":
						nextView = zoomAt(nextView, KEY_ZOOM, { width, height }, width / 2, height / 2)
						break
					case "-":
						nextView = zoomAt(nextView, 1 / KEY_ZOOM, { width, height }, width / 2, height / 2)
						break
					case "0":
						nextView = FITTED
						break
					case "ArrowLeft":
						nextView = panBy(nextView, KEY_PAN, 0)
						break
					case "ArrowRight":
						nextView = panBy(nextView, -KEY_PAN, 0)
						break
					case "ArrowUp":
						nextView = panBy(nextView, 0, KEY_PAN)
						break
					case "ArrowDown":
						nextView = panBy(nextView, 0, -KEY_PAN)
						break
				}

				break
		}
	}

	if (nextWindow !== voiWindow) changeWindow(nextWindow)

	if (nextView !== view) {
		view = nextView
		schedule()
	}
}

function onShell({ data }: MessageEvent<ShellToWorker>): void {
	switch (data.type) {
		case "canvas":
			hidden = data.hidden
			canvas = data.canvas
			context = canvas.getContext("2d")
			width = data.width
			height = data.height
			canvas.width = width
			canvas.height = height
			// A 2D canvas has no texture cap of its own: the shell's default bounds the backing store.
			send({ type: "limits", maxTextureSize: MAX_BACKING_SIDE })
			posted = ""
			schedule()
			break
		case "resize":
			width = data.width
			height = data.height

			if (canvas !== null) {
				canvas.width = width
				canvas.height = height
			}

			schedule()
			break
		case "input":
			input(data.events)
			break
		case "visibility":
			hidden = data.hidden
			setPlaying(playing)
			break
	}
}

function openFailure(error: unknown): DicomOpenResult {
	if (error instanceof DicomOpenError) return { info: null, failure: error.reason }

	return { info: null, failure: "damaged" }
}

// The decode in progress: the next waits for it, so no two decodes are ever weighed against the same held bytes (a
// browser JPEG decode or a codec's first load yields to the next request while its memory is still unclaimed).
let decoding: Promise<unknown> = Promise.resolve()

function decode(state: Opened, index: number): Promise<FrameSamples> {
	const run = decoding.then(() => decodeNow(state, index))

	decoding = run.catch(() => undefined)

	return run
}

async function decodeNow(state: Opened, index: number): Promise<FrameSamples> {
	const kept = cache.get(index)

	if (kept !== undefined) return kept
	// The file changed while this waited.
	if (opened !== state) throw new DicomFrameFailure("unsupported", "another file is open")

	const { context: frameContext, fragments } = state

	if (frameContext === null) throw new DicomFrameFailure("unsupported", "no image")

	const decoded = fragments === null ? nativeFrame(frameContext, index) : await encapsulatedFrame(frameContext, fragments, index)

	cache.set(index, decoded, decoded.data.byteLength)

	return decoded
}

// The frame after the one on screen in play order, decoded into the cache while cine plays and the cache would keep
// it (sized as the frame on screen). A frame that fails is let be: its own step shows why.
async function prefetch(state: Opened, index: number): Promise<void> {
	const shown = samples

	if (!playing || hidden || opened !== state || shown === null || cache.has(index) || !cache.keeps(index, shown.data.byteLength)) return

	try {
		await decode(state, index)
	} catch {
		// shown by its own step
	}
}

async function showFrame(index: number): Promise<DicomFrameOutcome> {
	const state = opened

	if (state === null) return "unsupported"

	const ticket = ++requested

	cache.anchor(index, state.info.frames, playing)

	try {
		const decoded = await decode(state, index)

		if (ticket !== requested) return "ok"

		samples = decoded
		current = index
		failure = null

		if (baseWindow === null) {
			const [first] = state.module.windows

			baseWindow =
				first ?? (decoded.color === "gray" ? rangeWindow(modalityRange(decoded, state.model)) : { center: 127.5, width: 256 })
			voiWindow ??= baseWindow
		}

		imageStale = true
		schedule()

		return "ok"
	} catch (error) {
		if (ticket !== requested) return "ok"

		const outcome = error instanceof DicomFrameFailure ? error.reason : "unreadable"

		current = index
		samples = null
		failure = outcome
		schedule()

		return outcome
	}
}

const api = {
	open: (source: DicomOpenSource, budget: DicomBudget): DicomOpenResult => {
		forgetFile()
		decodeBytes = budget.decodeBytes

		try {
			const file = source.kind === "ranged" ? rangedSource(source) : memorySource(source.bytes)
			const header = readHeader(file, { decodeBytes })
			const module = readPixelModule(header.dataSet, header.syntax?.littleEndian ?? true)
			const verdict = imageVerdict(module, header.syntax, DECODERS)
			// What stays held while a frame is read: an inflated data set, else the whole file read into memory, the
			// parsed header, and (ranged) the bridge's slots; the frame's own bytes are its decoder's to count.
			const held = fileHeld(header, source.kind === "whole" ? file.size : 0)
			const ringBytes = source.kind === "ranged" ? source.ringBytes : 0
			const frameContext: FrameContext | null =
				verdict.status === "ok" && header.syntax !== null
					? {
							module,
							syntax: header.syntax,
							color: verdict.color,
							source: header.pixels,
							budget: {
								get decodeBytes() {
									return decodeBytes
								},
								held: () => held + ringBytes + framesHeld(),
								heap: codecHeap,
								// Past what the budget leaves, a grown heap goes even while cine plays.
								settle: (decoder, need) => {
									const heap = codecHeap(decoder)

									if (releasesHeap(heap, need, playing) || held + ringBytes + framesHeld() + heap > decodeBytes)
										releaseCodec(decoder)
								},
								release: releaseCodec
							},
							compressed: decodeCompressed
						}
					: null
			const color = verdict.status === "ok" ? verdict.color : null
			const info: DicomInfo = {
				image: verdict.status,
				modality: module.modality,
				rows: module.rows,
				columns: module.columns,
				frames: module.frames,
				frameTimeMs: module.frameTimeMs ?? DEFAULT_FRAME_MS,
				windowed: color === "gray",
				windows: module.windows,
				hounsfield: module.modality === "CT"
			}

			opened = {
				header,
				module,
				context: frameContext,
				fragments: frameContext === null ? null : fragmentIndex(frameContext),
				model: grayModel(module),
				info,
				text: textOf(header.dataSet, null)
			}

			return { info, failure: null }
		} catch (error) {
			return openFailure(error)
		}
	},
	// A refined device profile's budget, for the frames still to decode (the file stays open).
	setBudget: (budget: DicomBudget): void => {
		decodeBytes = budget.decodeBytes
	},
	attach: (port: MessagePort): void => {
		shell?.close()
		shell = port
		port.onmessage = onShell
	},
	// Decodes and shows frame `index`; a step pauses playback.
	show: async (index: number): Promise<DicomFrameOutcome> => {
		setPlaying(false)

		return await showFrame(index)
	},
	play: (on: boolean): void => {
		setPlaying(on)
	},
	// Null goes back to the file's default.
	setWindow: (next: Window | null): void => {
		changeWindow(next)
	},
	setInvert: (on: boolean): void => {
		invert = on
		imageStale = true
		schedule()
	},
	fit: (): void => {
		view = FITTED
		schedule()
	},
	// The file's window, no Invert, fitted.
	reset: (): void => {
		invert = false
		view = FITTED
		changeWindow(null)
	},
	tags: (path: readonly number[]): DicomTagLevel => {
		const state = opened

		return state === null ? { rows: [], more: 0 } : tagLevel(state.header.dataSet, path, state.text)
	},
	// The whole value of the row at `path`, for a copy (one value at a time).
	tagValue: (path: readonly number[]): string | null => {
		const state = opened

		return state === null ? null : tagValue(state.header.dataSet, path, state.text)
	}
}

export type DicomWorkerApi = typeof api

Comlink.expose(api)
