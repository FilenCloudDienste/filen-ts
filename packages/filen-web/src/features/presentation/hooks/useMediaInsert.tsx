import { useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import * as Comlink from "comlink"
import { toast } from "sonner"
import { driveItemName } from "@filen/shared"
import type { InsertedImage, InsertedMedia, ShapeNode, SlideLayer, SlideRef, Xfrm } from "@filen/office/core/presentation"
import type { MediaInsertSource, MediaRefusal, PresentationNotice } from "@filen/office/dom/presentation"
import {
	noteMediaDuration,
	showMediaMount,
	slideShapes,
	type PresentationActionActivator,
	type PresentationStore,
	type ShowMediaLabels,
	type ShowMediaMount,
	type ShowMediaStreams
} from "@filen/office/react/presentation"
import { DriveFilePickerDialog } from "@/features/drive/components/driveFilePickerDialog"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import { anyFileTypeFacts, type DriveItem } from "@/features/drive/lib/item"
import { itemTypeExtension, previewCategoryForExtension } from "@/features/drive/lib/preview.logic"
import type { PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import {
	holdPreviewStreamAlive,
	previewStreamIdOf,
	previewStreamUrl,
	registerPortStream,
	releasePreviewStream
} from "@/features/preview/lib/previewStream"
import { openRemuxSession } from "@/lib/media/mseController"
import { sdkApi } from "@/lib/sdk/client"
import { log } from "@/lib/log"
import type { PreviewKey } from "@/lib/i18n"

// Video and audio on slides, the page's side: inserting them, and the streams the player reads them through.
//
// Insert: into the slide in view, from this device or the drive. The worker reads the file once (its size,
// container and CRC-32) and keeps only where to read it again; the page probes the medium through a <video> element
// over a blob URL (device) or the service worker's stream (drive) for its size, duration and a poster frame, then
// inserts it as one op. The bytes go into the package only when the deck is saved, streamed as a stored entry.

export type MediaKind = "video" | "audio"

const EMU_PER_PX = 9525
// The poster's longest side, px.
const POSTER_MAX = 1280
// Audio shows as an icon of this many EMU (half an inch), as PowerPoint inserts it.
const AUDIO_ICON_EMU = 457_200
const AUDIO_ICON_PX = 256
// The share of the slide a new video takes at most.
const VIDEO_SHARE = 0.6
const PROBE_TIMEOUT_MS = 15_000

const ACCEPT: Readonly<Record<MediaKind, string>> = {
	video: "video/*,.mp4,.m4v,.mov,.webm,.ogv,.avi,.wmv,.mkv",
	audio: "audio/*,.mp3,.m4a,.wav,.ogg,.oga,.flac,.aac,.wma,.aif,.aiff"
}

const REFUSAL_KEYS: Readonly<Record<MediaRefusal["reason"], PreviewKey>> = {
	notMedia: "previewPptxMediaNotMedia",
	tooLarge: "previewPptxMediaTooLarge",
	notFound: "previewPptxMediaFailed",
	linked: "previewPptxMediaFailed",
	preparing: "previewPptxMediaFailed",
	notImplemented: "previewPptxMediaFailed"
}

interface Probe {
	readonly width: number
	readonly height: number
	readonly durationMs?: number
	readonly poster: InsertedImage
}

async function canvasImage(canvas: HTMLCanvasElement, type: "image/png" | "image/jpeg"): Promise<InsertedImage> {
	const blob = await new Promise<Blob | null>(resolve => {
		canvas.toBlob(resolve, type, 0.85)
	})

	if (blob === null) throw new Error("the poster could not be encoded")

	return { bytes: new Uint8Array(await blob.arrayBuffer()), contentType: type, width: canvas.width, height: canvas.height }
}

// A speaker glyph, our own drawing: what an audio clip shows on the slide.
function audioIcon(): Promise<InsertedImage> {
	const canvas = document.createElement("canvas")
	const size = AUDIO_ICON_PX

	canvas.width = size
	canvas.height = size

	const context = canvas.getContext("2d")

	if (context === null) throw new Error("no canvas")

	const unit = size / 24

	context.fillStyle = "#3f3f46"
	context.beginPath()
	context.moveTo(3 * unit, 9 * unit)
	context.lineTo(7 * unit, 9 * unit)
	context.lineTo(12 * unit, 4 * unit)
	context.lineTo(12 * unit, 20 * unit)
	context.lineTo(7 * unit, 15 * unit)
	context.lineTo(3 * unit, 15 * unit)
	context.closePath()
	context.fill()
	context.strokeStyle = "#3f3f46"
	context.lineWidth = 2 * unit
	context.lineCap = "round"

	for (const radius of [4, 7.5]) {
		context.beginPath()
		context.arc(12 * unit, 12 * unit, radius * unit, -Math.PI / 4, Math.PI / 4)
		context.stroke()
	}

	return canvasImage(canvas, "image/png")
}

// A neutral poster for a video the browser cannot decode: a dark frame with a play glyph.
function placeholderPoster(width: number, height: number): Promise<InsertedImage> {
	const canvas = document.createElement("canvas")

	canvas.width = width
	canvas.height = height

	const context = canvas.getContext("2d")

	if (context === null) throw new Error("no canvas")

	context.fillStyle = "#18181b"
	context.fillRect(0, 0, width, height)
	context.fillStyle = "#e4e4e7"

	const r = Math.min(width, height) / 6

	context.beginPath()
	context.moveTo(width / 2 - r * 0.6, height / 2 - r)
	context.lineTo(width / 2 + r, height / 2)
	context.lineTo(width / 2 - r * 0.6, height / 2 + r)
	context.closePath()
	context.fill()

	return canvasImage(canvas, "image/png")
}

function waitFor(element: HTMLMediaElement, event: "loadedmetadata" | "seeked", signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const done = (): void => {
			element.removeEventListener(event, onEvent)
			element.removeEventListener("error", onError)
			signal.removeEventListener("abort", onError)
		}
		const onEvent = (): void => {
			done()
			resolve()
		}
		const onError = (): void => {
			done()
			reject(new Error(`the medium did not reach ${event}`))
		}

		element.addEventListener(event, onEvent, { once: true })
		element.addEventListener("error", onError, { once: true })
		signal.addEventListener("abort", onError, { once: true })
	})
}

// Size, duration and a poster frame of the medium at `url` (a tenth of the way in, at most 1 s); a video the browser
// cannot decode gets a neutral poster at 16:9.
// How long a dropped element is given to say it has let go of its source (`emptied`) before its URL goes anyway.
const LET_GO_MS = 2000
// How long a reset player is given after `emptied` to finish its last reads (100 times the tail measured in WebKit).
const SETTLE_MS = 1000
// Drops a media element's source: paused, told to load nothing more, unlinked and reset (load() with none). Resolves
// once the element has emptied and its player has settled: WebKit's player still issues a last read or two of the old
// source after `emptied` (measured: up to 10 ms after it), and a blob URL revoked under such a read fails it
// ("WebKitBlobResource error 1"). `waitMs` bounds the wait for `emptied`.
export function letGo(
	element: Pick<HTMLMediaElement, "removeAttribute" | "load" | "addEventListener" | "pause" | "preload">,
	waitMs = LET_GO_MS,
	settleMs = SETTLE_MS
): Promise<void> {
	const emptied = new Promise<void>(resolve => {
		const timer = setTimeout(resolve, waitMs)

		element.addEventListener(
			"emptied",
			() => {
				clearTimeout(timer)
				resolve()
			},
			{ once: true }
		)
	})

	element.pause()
	element.preload = "none"
	element.removeAttribute("src")
	element.load()

	return emptied.then(() => new Promise<void>(resolve => setTimeout(resolve, settleMs)))
}

// Runs `release` (an object URL revoked, a stream let go) once every one of `holds` has settled, whichever way: no
// sooner, so nothing still reading the URL loses it, and no later.
export function releaseAfter(holds: readonly Promise<unknown>[], release: () => void): void {
	void Promise.allSettled(holds).then(release)
}

async function probe(url: string, kind: MediaKind, signal: AbortSignal, hold: (released: Promise<void>) => void): Promise<Probe> {
	const element = document.createElement(kind)
	const deadline = AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)])

	element.muted = true
	element.preload = "metadata"
	element.src = url

	try {
		await waitFor(element, "loadedmetadata", deadline)

		const durationMs = Number.isFinite(element.duration) ? Math.round(element.duration * 1000) : undefined

		if (kind === "audio" || !(element instanceof HTMLVideoElement)) {
			return {
				width: AUDIO_ICON_PX,
				height: AUDIO_ICON_PX,
				...(durationMs === undefined ? {} : { durationMs }),
				poster: await audioIcon()
			}
		}

		const width = element.videoWidth
		const height = element.videoHeight

		if (width === 0 || height === 0) throw new Error("no picture")

		element.currentTime = Math.min(1, (element.duration || 0) / 10)
		await waitFor(element, "seeked", deadline)

		const scale = Math.min(1, POSTER_MAX / Math.max(width, height))
		const canvas = document.createElement("canvas")

		canvas.width = Math.max(1, Math.round(width * scale))
		canvas.height = Math.max(1, Math.round(height * scale))
		canvas.getContext("2d")?.drawImage(element, 0, 0, canvas.width, canvas.height)

		return { width, height, ...(durationMs === undefined ? {} : { durationMs }), poster: await canvasImage(canvas, "image/jpeg") }
	} catch (error) {
		if (signal.aborted) throw error
		if (kind === "audio") return { width: AUDIO_ICON_PX, height: AUDIO_ICON_PX, poster: await audioIcon() }

		return { width: 1280, height: 720, poster: await placeholderPoster(1280, 720) }
	} finally {
		hold(letGo(element))
	}
}

// The box a new medium takes: a video within VIDEO_SHARE of the slide at its aspect, an audio icon; centred.
export function mediaBox(slide: { readonly cx: number; readonly cy: number }, kind: MediaKind, width: number, height: number): Xfrm {
	let cx: number
	let cy: number

	if (kind === "audio") {
		cx = AUDIO_ICON_EMU
		cy = AUDIO_ICON_EMU
	} else {
		const scale = Math.min((slide.cx * VIDEO_SHARE) / (width * EMU_PER_PX), (slide.cy * VIDEO_SHARE) / (height * EMU_PER_PX), 1)

		cx = Math.round(width * EMU_PER_PX * scale)
		cy = Math.round(height * EMU_PER_PX * scale)
	}

	return { x: Math.round((slide.cx - cx) / 2), y: Math.round((slide.cy - cy) / 2), cx, cy, rot: 0, flipH: false, flipV: false }
}

export function isMediaFile(kind: MediaKind): (item: DriveItem) => boolean {
	return item => previewCategoryForExtension(itemTypeExtension(item)) === kind
}

type Picked = { readonly kind: "file"; readonly file: File } | { readonly kind: "drive"; readonly item: DriveItem }

// Inserts `media` as `shape` on `slide` and selects it once the slide shows it, as every other insert does; the length
// the probe read is kept for the Trim dialog.
export async function insertMediaShape(
	editor: PresentationRibbonEditor,
	slide: SlideRef,
	shape: ShapeNode,
	media: InsertedMedia
): Promise<void> {
	const render = editor.render?.ref === slide ? editor.render : (await editor.session.render([slide]))[0]

	if (media.durationMs !== undefined) noteMediaDuration(editor.session, `inserted:${String(media.id)}`, media.durationMs / 1000)
	const withdraw =
		render === undefined
			? undefined
			: editor.selection.selectNew(
					slide,
					slideShapes(render).map(entry => entry.id)
				)

	if (!(await editor.command({ family: "media", kind: "insert", slide, shape, media })).ok) withdraw?.()
}

// Inserts one medium into the slide in view; resolves once it is in (or refused, with a toast).
async function insertMedia(
	editor: PresentationRibbonEditor,
	picked: Picked,
	kind: MediaKind,
	signal: AbortSignal,
	t: TFunction<"preview">
): Promise<void> {
	// The slide in view, whether or not anything on it is selected.
	const slide = editor.render?.ref ?? editor.selection.getSnapshot().slide

	if (slide === undefined) return

	const name = picked.kind === "file" ? picked.file.name : driveItemName(picked.item)
	const reading = toast.loading(t("previewPptxMediaReading", { name }))
	let url: string | undefined
	// What still reads `url` after the insert: the probe's element until it has let go.
	const holds: Promise<void>[] = []
	const hold = (released: Promise<void>): void => {
		holds.push(released)
	}

	try {
		let source: MediaInsertSource

		if (picked.kind === "file") {
			url = URL.createObjectURL(picked.file)
			source = { kind: "file", file: picked.file }
		} else {
			const file = narrowToAnyFile(picked.item)
			const type = anyFileTypeFacts(file)?.mime ?? ""
			const { port1, port2 } = new MessageChannel()

			url = await previewStreamUrl(file, name, type || `${kind}/mp4`)
			await sdkApi.openRangePort(Comlink.transfer(port1, [port1]), file, crypto.randomUUID())
			source = { kind: "range", port: port2, size: Number(file.size), checked: true, name, type }
		}

		const [probed, registered] = await Promise.all([probe(url, kind, signal, hold), editor.session.registerMedia(source)])

		if (signal.aborted) return
		if ("reason" in registered) {
			toast.error(t(REFUSAL_KEYS[registered.reason]))

			return
		}

		const media: InsertedMedia = {
			...registered,
			poster: probed.poster,
			...(probed.durationMs === undefined ? {} : { durationMs: probed.durationMs })
		}
		const shape: ShapeNode = {
			id: 0,
			name,
			hidden: false,
			kind: "pic",
			xfrm: mediaBox(editor.info.size, registered.kind, probed.width, probed.height),
			alt: { descr: name }
		}

		await insertMediaShape(editor, slide, shape, media)
	} catch (error) {
		if (!signal.aborted) {
			log.warn("presentation", "media not inserted", { error })
			toast.error(t("previewPptxMediaFailed"))
		}
	} finally {
		toast.dismiss(reading)

		if (url !== undefined) {
			const done = url

			// The insert is over (made, refused or cancelled): the URL goes once the probe's element has let go of it too.
			releaseAfter(holds, () => {
				if (picked.kind === "file") URL.revokeObjectURL(done)
				else releasePreviewStream(previewStreamIdOf(done))
			})
		}
	}
}

export interface MediaInsertControls {
	// Opens the file chooser (call inside the click: it needs the user's activation).
	fromDevice(kind: MediaKind): void
	fromDrive(kind: MediaKind): void
	// The hidden file chooser and the drive picker, rendered by the caller.
	readonly elements: ReactNode
}

export function useMediaInsert(editor: PresentationRibbonEditor | undefined): MediaInsertControls {
	const { t } = useTranslation("preview")
	const inputRef = useRef<HTMLInputElement | null>(null)
	const [deviceKind, setDeviceKind] = useState<MediaKind>("video")
	const [driveKind, setDriveKind] = useState<MediaKind | null>(null)
	const run = (picked: Picked, kind: MediaKind, signal: AbortSignal): Promise<void> =>
		editor === undefined ? Promise.resolve() : insertMedia(editor, picked, kind, signal, t)

	return {
		fromDevice: kind => {
			setDeviceKind(kind)

			const input = inputRef.current

			if (input === null) return

			input.accept = ACCEPT[kind]
			input.click()
		},
		fromDrive: kind => {
			setDriveKind(kind)
		},
		elements: (
			<>
				<input
					ref={inputRef}
					type="file"
					className="hidden"
					tabIndex={-1}
					aria-hidden
					accept={ACCEPT[deviceKind]}
					onChange={event => {
						const file = event.currentTarget.files?.[0]

						event.currentTarget.value = ""

						if (file !== undefined) void run({ kind: "file", file }, deviceKind, new AbortController().signal)
					}}
				/>
				{driveKind === null ? null : (
					<DriveFilePickerDialog
						title={t(driveKind === "video" ? "previewPptxVideoDriveTitle" : "previewPptxAudioDriveTitle")}
						description={t(driveKind === "video" ? "previewPptxVideoDriveDescription" : "previewPptxAudioDriveDescription")}
						accept={isMediaFile(driveKind)}
						onPick={async (item, signal) => {
							await run({ kind: "drive", item }, driveKind, signal)
							setDriveKind(null)
						}}
						onClose={() => {
							setDriveKind(null)
						}}
					/>
				)}
			</>
		)
	}
}

class MediaRefused extends Error {
	readonly reason: MediaRefusal["reason"]

	constructor(reason: MediaRefusal["reason"]) {
		super(`media refused: ${reason}`)
		this.name = "MediaRefused"
		this.reason = reason
	}
}

// Playing: a medium's bytes come from the deck's worker by range (media(part, port)), registered with the service
// worker so the element streams and seeks them like a drive file's; a format the browser cannot decode goes through
// the MediaSource remux path fed by the same port. Linked media are never fetched: a web address opens through the
// deck's link activator (its host shown first).

// The share of a deflated medium's preparation the worker last reported for `part` (its "media" notices).
export function preparingProgress(notices: readonly PresentationNotice[], part: string | undefined): number | undefined {
	let progress: number | undefined

	for (const notice of notices) {
		if (notice.kind === "media" && notice.reason === "preparing" && notice.part.toLowerCase() === part?.toLowerCase()) {
			progress = Math.max(progress ?? 0, notice.progress ?? 0)
		}
	}

	return progress
}

// The page's side of a medium's bytes, shared by the canvas and the show; `shape` opens a linked medium's web address
// through the deck's link activator; `store` (the deck's) tells a preparing medium's progress. While a stream is
// registered the service worker is kept alive (an idle one drops its registrations, and a paused element's next range
// request would fail).
export function mediaStreams(
	activator: PresentationActionActivator | undefined,
	shape: SlideLayer["shape"] | undefined,
	store?: PresentationStore
): ShowMediaStreams {
	return {
		async url(session, media) {
			const part = media.part

			if (part === undefined) return { kind: "refused", reason: "linked" }

			const id = crypto.randomUUID()
			const alive = holdPreviewStreamAlive()

			try {
				const url = await registerPortStream(
					id,
					async port => {
						const meta = await session.media(part, port)

						if ("reason" in meta) throw new MediaRefused(meta.reason)

						return {
							name: part.slice(part.lastIndexOf("/") + 1),
							size: meta.size,
							contentType: meta.contentType,
							readAhead: meta.seekable
						}
					},
					() => undefined
				)

				return {
					kind: "url",
					url,
					release: () => {
						releasePreviewStream(id)
						alive()
					}
				}
			} catch (error) {
				alive()

				return { kind: "refused", reason: error instanceof MediaRefused ? error.reason : "notFound" }
			}
		},
		...(store === undefined
			? {}
			: {
					prepared(media, listener) {
						const check = (): void => {
							const progress = preparingProgress(store.getSnapshot().notices, media.part)

							if (progress !== undefined) listener(progress)
						}
						const off = store.subscribe(check)

						check()

						return off
					}
				}),
		async remux(session, media, element) {
			const part = media.part

			if (part === undefined) return undefined

			const { port1, port2 } = new MessageChannel()
			const meta = await session.media(part, port2)

			if ("reason" in meta) {
				port1.close()

				return undefined
			}

			const remuxed = await openRemuxSession({ port: port1, size: meta.size, onFailure: () => undefined })

			await remuxed.attach(element)

			return {
				play: () => remuxed.play(),
				seek: seconds => {
					remuxed.seek(seconds)
				},
				dispose: () => {
					remuxed.dispose()
				}
			}
		},
		openLink(href) {
			if (activator !== undefined && shape !== undefined)
				activator.action({ kind: "url", href }, { via: "click", mode: "view", modifier: false, shape })
		}
	}
}

export function showMediaLabels(t: TFunction<"preview">): ShowMediaLabels {
	return {
		openLink: t("previewPptxMediaOpenLink"),
		preparing: t("previewPptxMediaPreparingStart"),
		preparingProgress: percent => t("previewPptxMediaPreparing", { percent }),
		unplayable: t("previewPptxMediaUnplayable"),
		unavailable: t("previewPptxMediaUnavailable")
	}
}

// The show's media mount (the stage's player takes it): a mount per medium, so a linked one opens as its own shape;
// `store` (the deck's) lets a medium still preparing show its progress and play once it is ready.
export function useShowMediaMount(actions: PresentationActionActivator | undefined, store?: PresentationStore): ShowMediaMount {
	const { t } = useTranslation("preview")
	const labels = showMediaLabels(t)

	return {
		mount: (box, layer, session, events) =>
			showMediaMount(mediaStreams(actions, layer.shape, store), { labels, hoverControls: true }).mount(box, layer, session, events),
		// A slide's transition sound: its bytes by the same range path, no shape to open a link for.
		sound: (session, sound) =>
			showMediaMount(mediaStreams(actions, undefined, store), { labels }).sound?.(session, sound) ?? { stop: () => undefined }
	}
}
