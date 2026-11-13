import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import {
	CameraIcon,
	PauseIcon,
	PlayIcon,
	Redo2Icon,
	RepeatIcon,
	ScissorsIcon,
	SkipBackIcon,
	SkipForwardIcon,
	SplitIcon,
	Undo2Icon,
	ZoomInIcon,
	ZoomOutIcon
} from "lucide-react"
import { isImeKeydown } from "@filen/shared/keymap"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import type { DriveItem } from "@/features/drive/lib/item"
import type { AspectPreset } from "@/features/preview/imageEdit/types"
import type {
	ExportOutcome,
	ExportPlan,
	ExportProgress,
	TimeRange,
	VideoEditClient,
	VideoEditRecipe,
	VideoSaveTarget,
	VideoSourceInfo
} from "@/features/preview/videoEdit/types"
import {
	aspectCrop,
	clampTexts,
	croppedSize,
	cropFromNormalised,
	flipRecipe,
	identityVideoRecipe,
	isIdentityVideoRecipe,
	keepIndexAt,
	MIN_KEEP_SECONDS,
	moveKeepEdge,
	newTextOverlay,
	outputDuration,
	rectFromView,
	removeSection,
	restoreSection,
	setTrim,
	sourceToOutput,
	stageRecipe,
	turnRecipe,
	type StageMode,
	type NormalisedRect
} from "@/features/preview/videoEdit/lib/recipe"
import {
	formatTimecode,
	frameDuration,
	fullView,
	revealTime,
	snapMarks,
	zoomView,
	ZOOM_STEP,
	type TimelineView
} from "@/features/preview/videoEdit/lib/timeline.logic"
import { colourBlockedByHdr, unavailableFeatures } from "@/features/preview/videoEdit/lib/availability"
import { repeatsWhileHeld, videoEditorKey, type EditorVideoAction } from "@/features/preview/videoEdit/lib/keys"
import { EditorPlayback } from "@/features/preview/videoEdit/components/editorPlayback"
import { drawBitmap, FrameRequests } from "@/features/preview/videoEdit/components/frameRequests"
import { VideoStage } from "@/features/preview/videoEdit/components/videoStage"
import { VideoTimeline } from "@/features/preview/videoEdit/components/videoTimeline"
import { VideoEditPanel, type VideoEditTab } from "@/features/preview/videoEdit/components/videoEditPanel"
import { ExportBar, SavePopover, type ExportState } from "@/features/preview/videoEdit/components/videoSaveControls"
import { FILTER_PRESETS } from "@/features/preview/imageEdit/lib/filters"
import { createHistory } from "@/lib/editHistory"
import { Kbd } from "@/lib/keymap/kbd"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { isRecordingCombo, useBindings } from "@/lib/keymap/registry"
import { useEditorLayerKeys } from "@/lib/keymap/editorLayerKeys"
import { useMediaPaused } from "@/lib/media/useMediaState"
import { useIsOnline } from "@/lib/useIsOnline"
import { useLatestRef } from "@/lib/useLatestRef"
import { log } from "@/lib/log"

// The overlay's handle on the open editor: its Mod+S (preview.save) opens the Save popover.
export interface VideoEditorCommands {
	openSave: () => void
}

export interface VideoEditorProps {
	client: VideoEditClient
	// Read once by the overlay before the editor opens (only a previewable source opens it).
	info: VideoSourceInfo
	item: DriveItem
	// The file's name, for the toasts; `title` is how the header shows it (the overlay's dialog title).
	name: string
	title: ReactNode
	onDirtyChange: (dirty: boolean) => void
	// The header's Cancel (the overlay asks first over unsaved edits).
	onCancel: () => void
	// Leaves the editor with nothing left to ask about: saved, or handed to a transfer.
	onExit: () => void
	// A save finished while the editor was open: the overlay shows the new version (in place) or offers the copy.
	onSaved: (uuid: string, target: VideoSaveTarget) => void
	// Uploads a still beside the video; resolves with its file name.
	onSaveFrame: (blob: Blob, extension: "jpg") => Promise<string>
	commandsRef: RefObject<VideoEditorCommands | null>
}

interface Snapshot {
	recipe: VideoEditRecipe
	canUndo: boolean
	canRedo: boolean
}

interface RunningExport {
	handle: ReturnType<VideoEditClient["exportVideo"]>
	target: VideoSaveTarget
	// Hands the export to a transfer and tells its end by a toast.
	toBackground: () => void
}

// Plans wait this long after the last edit: a slider drag asks once it rests.
const PLAN_DELAY_MS = 150
// Filter thumbnails, square, in CSS px.
const FILTER_THUMBNAIL_SIZE = 96
const STILL_QUALITY = 0.92

// A key in a field is the field's own; a slider, tab or text box keeps its arrows, a button its Space and Enter.
function ownsKey(event: KeyboardEvent | ReactKeyboardEvent): boolean {
	const target = event.target

	if (!(target instanceof Element)) {
		return false
	}

	if (target.matches("input:not([type=range]), textarea, select, [contenteditable]")) {
		return true
	}

	const navigation = /^(Arrow|Page|Home$|End$)/.test(event.key)

	if (navigation && target.matches("input[type=range], [role=slider], [role=tab], [role=radio], [role=button]")) {
		return true
	}

	return (event.key === " " || event.key === "Enter") && target.matches("button, [role=button], [role=tab], a[href]")
}

async function stillBlob(bitmap: ImageBitmap): Promise<Blob> {
	const canvas = document.createElement("canvas")

	canvas.width = bitmap.width
	canvas.height = bitmap.height
	canvas.getContext("2d")?.drawImage(bitmap, 0, 0)

	return await new Promise<Blob>((resolve, reject) => {
		canvas.toBlob(
			blob => {
				if (blob === null) {
					reject(new Error("encoding the frame failed"))
				} else {
					resolve(blob)
				}
			},
			"image/jpeg",
			STILL_QUALITY
		)
	})
}

// The video editor inside the preview overlay: its own header (Cancel, the file's name, Revert, Save ▾), the export's
// progress under it, the stage with the timeline docked beneath, and the tools panel beside them (a bottom sheet under
// the sm breakpoint) — the image editor's shell. Every edit is a recipe step (undo/redo, Revert); nothing decodes or
// encodes until Save, and the export then runs in the client (continuing as a transfer when sent to the background).
export function VideoEditor(props: VideoEditorProps) {
	const { t } = useTranslation(["preview", "common"])
	const idBase = useId()
	const rootRef = useRef<HTMLDivElement | null>(null)
	const timecodeRef = useRef<HTMLSpanElement | null>(null)
	const canvasRef = useRef<HTMLCanvasElement | null>(null)
	const loupeRef = useRef<HTMLCanvasElement | null>(null)
	const { client, info } = props
	const duration = info.duration
	const [history] = useState(() => createHistory(identityVideoRecipe(duration)))
	const [snapshot, setSnapshot] = useState<Snapshot>(() => ({ recipe: history.current, canUndo: false, canRedo: false }))
	const [playback] = useState(() => new EditorPlayback())
	const [frames] = useState(() => new FrameRequests(client))
	const [video, setVideo] = useState<HTMLVideoElement | null>(null)
	const [settledTime, setSettledTime] = useState(0)
	const [tab, setTab] = useState<VideoEditTab>("trim")
	const [view, setView] = useState<TimelineView>(() => fullView(duration))
	const [selection, setSelection] = useState<TimeRange | null>(null)
	const [splits, setSplits] = useState<readonly number[]>([])
	const [loop, setLoop] = useState(false)
	const [aspect, setAspect] = useState<AspectPreset>("free")
	const [selectedText, setSelectedText] = useState<string | null>(null)
	const [plan, setPlan] = useState<ExportPlan | null>(null)
	const [saveOpen, setSaveOpen] = useState(false)
	const [exportState, setExportState] = useState<ExportState | null>(null)
	const [thumbnails, setThumbnails] = useState<{ key: string; bitmaps: readonly ImageBitmap[] } | null>(null)
	const thumbnailsRef = useRef<readonly ImageBitmap[]>([])
	const running = useRef<RunningExport | null>(null)
	const lastTarget = useRef<VideoSaveTarget>("inPlace")
	const lastPercent = useRef(-1)
	const dirtyRef = useRef(false)
	const bindings = useBindings()
	const online = useIsOnline()
	const paused = useMediaPaused(video)
	const recipe = snapshot.recipe
	const exporting = exportState?.status === "running"
	const dirty = !isIdentityVideoRecipe(recipe, duration)
	const unavailable = unavailableFeatures(plan)
	const hdrBlocked = colourBlockedByHdr(info, plan)
	const mode: StageMode = tab === "crop" ? "crop" : tab === "text" ? "text" : "result"
	const fps = info.frameRate
	const outputLength = outputDuration(recipe.keep, recipe.speed)
	const snaps = !recipe.precise && plan?.mode === "copy" ? snapMarks(plan.snapped, fps) : []
	// Splits only mean something inside what is kept.
	const shownSplits = splits.filter(split => keepIndexAt(recipe.keep, split) !== -1)

	const sync = (): void => {
		setSnapshot({ recipe: history.current, canUndo: history.canUndo, canRedo: history.canRedo })
	}

	const commit = (next: VideoEditRecipe, coalesceKey?: string): void => {
		if (exporting) {
			return
		}

		history.push(clampTexts(next), coalesceKey)
		sync()
	}

	const change = (update: (current: VideoEditRecipe) => VideoEditRecipe, coalesceKey?: string): void => {
		commit(update(history.current), coalesceKey)
	}

	const undo = (): void => {
		if (!exporting) {
			history.undo()
			sync()
		}
	}

	const redo = (): void => {
		if (!exporting) {
			history.redo()
			sync()
		}
	}

	const revert = (): void => {
		setSelection(null)
		setSplits([])
		setAspect("free")
		setSelectedText(null)
		commit(identityVideoRecipe(duration))
	}

	// ---- Playback. ----

	useEffect(() => {
		playback.attach(video)

		return () => {
			playback.detach()
		}
	}, [playback, video])

	useEffect(() => {
		playback.setKeep(recipe.keep)
		playback.setSpeed(recipe.speed)
		playback.setLoop(loop ? selection : null)
		playback.setSound(recipe.audio.mute, recipe.audio.gainDb)
	}, [playback, recipe.keep, recipe.speed, recipe.audio.mute, recipe.audio.gainDb, loop, selection])

	// Where the playhead settles (a pause, a seek), for the exact frame and the panels; never per frame.
	useEffect(() => {
		if (video === null) {
			return
		}

		const settle = (): void => {
			if (video.paused) {
				setSettledTime(video.currentTime)
			}
		}

		video.addEventListener("seeked", settle)
		video.addEventListener("pause", settle)
		video.addEventListener("loadeddata", settle)

		return () => {
			video.removeEventListener("seeked", settle)
			video.removeEventListener("pause", settle)
			video.removeEventListener("loadeddata", settle)
		}
	}, [video])

	const latestView = useLatestRef(view)

	// The time read-out follows the playhead directly; while playing, a zoomed timeline pages along with it.
	useEffect(() => {
		// Written here only, never by a render: a render would put back a stale text node.
		const showTime = (time: number): void => {
			if (timecodeRef.current !== null) {
				timecodeRef.current.textContent = `${formatTimecode(time)} / ${formatTimecode(duration)}`
			}
		}

		showTime(playback.time)

		return playback.subscribe(time => {
			showTime(time)

			if (!playback.paused) {
				const current = latestView.current
				const next = revealTime(current, time, duration)

				if (next !== current) {
					setView(next)
				}
			}
		})
	}, [playback, duration, latestView])

	const seek = (time: number): void => {
		playback.seek(Math.min(duration, Math.max(0, time)))
	}

	const step = (seconds: number): void => {
		playback.pause()
		seek(playback.time + seconds)
	}

	// A trim handle dragged: the exact frame there on the stage and in the loupe.
	const scrub = (time: number): void => {
		playback.pause()
		playback.seek(time)

		const canvas = canvasRef.current
		const width = (canvas?.clientWidth ?? 0) * window.devicePixelRatio

		if (canvas === null || width <= 0) {
			return
		}

		frames.request(time, stageRecipe(history.current, mode), width, bitmap => {
			drawBitmap(canvas, bitmap)
			canvas.setAttribute("data-ready", "")
			drawBitmap(loupeRef.current, bitmap)
		})
	}

	useEffect(() => {
		return () => {
			frames.dispose()
		}
	}, [frames])

	// ---- The plan (what a save would do), asked once the edits rest. ----

	useEffect(() => {
		let alive = true
		const timer = window.setTimeout(() => {
			client.plan(recipe).then(
				next => {
					if (alive) {
						setPlan(next)
					}
				},
				(error: unknown) => {
					log.warn("[videoEditor] plan failed", error)
				}
			)
		}, PLAN_DELAY_MS)

		return () => {
			alive = false
			window.clearTimeout(timer)
		}
	}, [client, recipe])

	const onDirtyChange = useLatestRef(props.onDirtyChange)

	useEffect(() => {
		if (dirty !== dirtyRef.current) {
			dirtyRef.current = dirty
			onDirtyChange.current(dirty)
		}
	}, [dirty, onDirtyChange])

	// ---- Filter thumbnails: the paused frame per filter, following the geometry and the playhead only. ----

	const thumbnailsKey = JSON.stringify({
		crop: recipe.crop,
		rotate: recipe.rotate,
		flipH: recipe.flipH,
		flipV: recipe.flipV,
		settledTime
	})
	const latestRecipe = useLatestRef(recipe)
	const shownThumbnailsKey = thumbnails?.key ?? null

	useEffect(() => {
		if (tab !== "adjust" || !paused || hdrBlocked || shownThumbnailsKey === thumbnailsKey) {
			return
		}

		const controller = new AbortController()
		const base: VideoEditRecipe = { ...latestRecipe.current, text: [] }
		const filters: readonly (string | null)[] = [null, ...FILTER_PRESETS.map(preset => preset.id)]

		void (async () => {
			const bitmaps: ImageBitmap[] = []

			for (const filter of filters) {
				if (controller.signal.aborted) {
					break
				}

				const bitmap = await client
					.frameAt(settledTime, { ...base, filter }, FILTER_THUMBNAIL_SIZE * window.devicePixelRatio)
					.catch((error: unknown) => {
						log.warn("[videoEditor] filter thumbnail failed", error)

						return null
					})

				if (bitmap === null) {
					break
				}

				bitmaps.push(bitmap)
			}

			if (controller.signal.aborted || bitmaps.length !== filters.length) {
				for (const bitmap of bitmaps) {
					bitmap.close()
				}

				return
			}

			for (const bitmap of thumbnailsRef.current) {
				bitmap.close()
			}

			thumbnailsRef.current = bitmaps
			setThumbnails({ key: thumbnailsKey, bitmaps })
		})()

		return () => {
			controller.abort()
		}
	}, [client, tab, paused, hdrBlocked, thumbnailsKey, shownThumbnailsKey, settledTime, latestRecipe])

	useEffect(() => {
		return () => {
			for (const bitmap of thumbnailsRef.current) {
				bitmap.close()
			}

			thumbnailsRef.current = []
		}
	}, [])

	// ---- Export. ----

	const progressOf = (progress: ExportProgress): void => {
		const percent = Math.floor(progress.fraction * 100)

		// One render per whole percent, not per chunk written.
		if (percent !== lastPercent.current) {
			lastPercent.current = percent
			setExportState({ status: "running", fraction: progress.fraction, etaSeconds: progress.etaSeconds })
		}
	}

	const settle = (handle: RunningExport["handle"], target: VideoSaveTarget, outcome: ExportOutcome): void => {
		// Sent to the background (or replaced): the transfer reports it.
		if (running.current?.handle !== handle) {
			return
		}

		running.current = null

		if (outcome.status === "cancelled") {
			setExportState(null)

			return
		}

		if (outcome.status === "error") {
			setExportState({ status: "failed", message: outcome.message })

			return
		}

		setExportState(null)
		toast.success(t(target === "copy" ? "previewVideoSaveDoneCopy" : "previewVideoSaveDone", { name: props.name }))
		dirtyRef.current = false
		props.onDirtyChange(false)
		props.onSaved(outcome.uuid, target)
		props.onExit()
	}

	const startExport = (target: VideoSaveTarget): void => {
		if (running.current !== null || !online || !dirty || !plan?.targets.includes(target)) {
			return
		}

		setSaveOpen(false)
		playback.pause()
		lastTarget.current = target
		lastPercent.current = -1
		setExportState({ status: "running", fraction: 0, etaSeconds: null })

		const handle = client.exportVideo(history.current, target, progressOf)

		running.current = {
			handle,
			target,
			toBackground: () => {
				followInBackground(handle, target)
			}
		}
		handle.done.then(
			outcome => {
				settle(handle, target, outcome)
			},
			(error: unknown) => {
				settle(handle, target, { status: "error", message: error instanceof Error ? error.message : "" })
			}
		)
	}

	// The export goes on as a transfer; its end is told by a toast, wherever the user is by then.
	const followInBackground = (handle: RunningExport["handle"], target: VideoSaveTarget): void => {
		const name = props.name

		handle.detachToTransfer()
		void handle.done.then(
			outcome => {
				if (outcome.status === "done") {
					toast.success(t(target === "copy" ? "previewVideoSaveDoneCopy" : "previewVideoSaveDone", { name }))
				} else if (outcome.status === "error") {
					toast.error(t("previewVideoSaveBackgroundFailed", { name }), { description: outcome.message })
				}
			},
			(error: unknown) => {
				log.error("[videoEditor] background export failed", error)
				toast.error(t("previewVideoSaveBackgroundFailed", { name }))
			}
		)
	}

	const continueInBackground = (): void => {
		const current = running.current

		if (current === null) {
			return
		}

		running.current = null
		current.toBackground()
		setExportState(null)
		dirtyRef.current = false
		props.onDirtyChange(false)
		props.onExit()
	}

	// Closed mid-export some other way: the export is never dropped, it carries on as a transfer.
	useEffect(() => {
		return () => {
			const current = running.current

			if (current !== null) {
				running.current = null
				current.toBackground()
			}
		}
	}, [])

	const saveFrame = (): void => {
		const time = playback.time
		const full = croppedSize(history.current, { width: info.width, height: info.height })

		playback.pause()
		void client
			.frameAt(time, history.current, full.width)
			.then(async bitmap => {
				const blob = await stillBlob(bitmap)

				bitmap.close()

				return await props.onSaveFrame(blob, "jpg")
			})
			.then(
				name => {
					toast.success(t("previewVideoEditFrameSaved", { name }))
				},
				(error: unknown) => {
					log.error("[videoEditor] saving the frame failed", error)
					toast.error(t("previewVideoEditFrameFailed"))
				}
			)
	}

	const commands = useLatestRef({
		openSave: () => {
			if (dirty && !exporting) {
				setSaveOpen(true)
			}
		}
	})
	const { commandsRef } = props

	useEffect(() => {
		commandsRef.current = {
			openSave: () => {
				commands.current.openSave()
			}
		}

		return () => {
			commandsRef.current = null
		}
	}, [commandsRef, commands])

	// ---- Timeline edits. ----

	const removeSelection = (): void => {
		const current = selection

		if (current === null) {
			return
		}

		const next = removeSection(history.current.keep, current, duration)

		if (next !== null) {
			commit({ ...history.current, keep: next })
			setSplits(splits.filter(split => split < current.start || split > current.end))
			setSelection(null)
			setLoop(false)
		}
	}

	const setIn = (): void => {
		const time = playback.time
		const end = selection !== null && selection.end > time + MIN_KEEP_SECONDS ? selection.end : null
		const range = history.current.keep[keepIndexAt(history.current.keep, time)]

		setSelection({ start: time, end: end ?? Math.max(time + MIN_KEEP_SECONDS, range?.end ?? duration) })
	}

	const setOut = (): void => {
		const time = playback.time
		const start = selection !== null && selection.start < time - MIN_KEEP_SECONDS ? selection.start : null
		const range = history.current.keep[keepIndexAt(history.current.keep, time)]

		setSelection({ start: start ?? Math.min(time - MIN_KEEP_SECONDS, range?.start ?? 0), end: time })
	}

	const split = (): void => {
		const time = playback.time

		if (keepIndexAt(history.current.keep, time) !== -1 && !splits.includes(time)) {
			setSplits([...splits, time].sort((a, b) => a - b))
		}
	}

	const zoom = (factor: number): void => {
		setView(zoomView(view, factor, playback.time, duration))
	}

	const handleAspect = (next: AspectPreset): void => {
		setAspect(next)

		if (next !== "free") {
			change(current => ({ ...current, crop: aspectCrop(next, { width: info.width, height: info.height }, current.rotate) }))
		}
	}

	const handleCrop = (shown: NormalisedRect, coalesceKey: string | undefined): void => {
		change(
			current => ({
				...current,
				crop: cropFromNormalised(rectFromView(shown, current.rotate, current.flipH, current.flipV), {
					width: info.width,
					height: info.height
				})
			}),
			coalesceKey
		)
	}

	const addText = (): void => {
		const id = crypto.randomUUID()
		const at = sourceToOutput(history.current.keep, history.current.speed, playback.time)

		change(current => ({ ...current, text: [...current.text, newTextOverlay(id, t("previewVideoEditTextDefault"), at, outputLength)] }))
		setSelectedText(id)
	}

	// ---- Keys. ----

	const runKey = (action: EditorVideoAction): void => {
		const frame = frameDuration(fps)

		switch (action) {
			case "preview.videoUndo":
				undo()
				break
			case "preview.videoRedo":
				redo()
				break
			case "preview.videoSaveCopy":
				startExport("copy")
				break
			case "preview.videoPlayPause":
				playback.toggle()
				break
			case "preview.videoShuttleBack":
				step(-1)
				break
			case "preview.videoShuttlePause":
				playback.pause()
				break
			case "preview.videoShuttleForward":
				playback.shuttleForward()
				break
			case "preview.videoFrameBack":
				step(-frame)
				break
			case "preview.videoFrameForward":
				step(frame)
				break
			case "preview.videoSecondBack":
				step(-1)
				break
			case "preview.videoSecondForward":
				step(1)
				break
			case "preview.videoToStart":
				playback.pause()
				seek(history.current.keep[0]?.start ?? 0)
				break
			case "preview.videoToEnd":
				playback.pause()
				seek(Math.max(0, (history.current.keep[history.current.keep.length - 1]?.end ?? duration) - frame))
				break
			case "preview.videoSetIn":
				setIn()
				break
			case "preview.videoSetOut":
				setOut()
				break
			case "preview.videoSplit":
				split()
				break
			case "preview.videoRemoveSection":
				removeSelection()
				break
			case "preview.videoLoop":
				setLoop(!loop)
				break
			case "preview.videoZoomIn":
				zoom(ZOOM_STEP)
				break
			case "preview.videoZoomOut":
				zoom(1 / ZOOM_STEP)
				break
			case "preview.videoZoomFit":
				setView(fullView(duration))
				break
			case "preview.videoSaveFrame":
				if (online) {
					saveFrame()
				}

				break
		}
	}

	// The editor's keys, here and elsewhere in its layer (its header), but never in a field (its typing and undo) nor
	// on a control that takes the key itself.
	const handleKey = (event: KeyboardEvent | ReactKeyboardEvent): void => {
		if (exporting || event.defaultPrevented || ownsKey(event) || isImeKeydown(event) || isRecordingCombo()) {
			return
		}

		const action = videoEditorKey(event, bindings, isMacPlatform())

		if (action === undefined) {
			return
		}

		event.preventDefault()

		if (event.repeat && !repeatsWhileHeld(action)) {
			return
		}

		runKey(action)
	}

	useEditorLayerKeys(rootRef, handleKey)

	// A darkroom in either app theme, as the image editor.
	return (
		<div
			ref={rootRef}
			data-preview-surface=""
			className="dark flex size-full min-h-0 flex-col bg-canvas text-foreground scheme-dark"
			onKeyDown={handleKey}
			onPointerUpCapture={() => {
				// A drag or slider gesture is one undo step.
				history.seal()
			}}
		>
			<header className="flex h-[calc(3.5rem+var(--window-inset-top))] shrink-0 items-center gap-1 px-4 pt-(--window-inset-top) pl-[max(1rem,var(--window-inset-left))] app-region-chrome">
				<div className="flex flex-1 basis-0 items-center">
					<Button
						variant="ghost"
						size="sm"
						disabled={exporting}
						onClick={props.onCancel}
					>
						{t("previewVideoSaveCancel")}
					</Button>
				</div>
				<div className="flex min-w-0 shrink justify-center px-2 font-heading text-sm font-medium max-sm:sr-only">{props.title}</div>
				<div className="flex flex-1 basis-0 items-center justify-end gap-1">
					<Button
						variant="ghost"
						size="sm"
						disabled={!dirty || exporting}
						onClick={revert}
					>
						{t("previewVideoSaveRevert")}
					</Button>
					<SavePopover
						plan={plan}
						recipe={recipe}
						info={info}
						unavailable={unavailable}
						dirty={dirty}
						online={online}
						busy={exporting}
						open={saveOpen}
						onOpenChange={setSaveOpen}
						onOutput={output => {
							change(current => ({ ...current, output }))
						}}
						onRemoveLocation={removeLocation => {
							change(current => ({ ...current, removeLocation }))
						}}
						onSave={startExport}
					/>
				</div>
			</header>
			{exportState !== null ? (
				<ExportBar
					state={exportState}
					onBackground={continueInBackground}
					onCancel={() => {
						running.current?.handle.cancel()
					}}
					onRetry={() => {
						setExportState(null)
						startExport(lastTarget.current)
					}}
					onDismiss={() => {
						setExportState(null)
					}}
				/>
			) : null}
			<div
				inert={exporting}
				className="flex min-h-0 flex-1 flex-col sm:flex-row"
			>
				<div className="flex min-h-0 min-w-0 flex-1 animate-in flex-col duration-300 ease-out fade-in-0 zoom-in-98 motion-reduce:animate-none">
					<div className="min-h-0 flex-1 px-4 pt-2 sm:px-6 sm:pt-4">
						<VideoStage
							item={props.item}
							positionKey={`videoEdit:${props.item.data.uuid}`}
							info={info}
							recipe={recipe}
							mode={mode}
							aspect={aspect}
							paused={paused}
							settledTime={settledTime}
							settledOutputTime={sourceToOutput(recipe.keep, recipe.speed, settledTime)}
							selectedText={selectedText}
							frames={frames}
							canvasRef={canvasRef}
							onVideo={setVideo}
							onCrop={handleCrop}
							onSelectText={id => {
								setSelectedText(id)
							}}
							onMoveText={(id, x, y, coalesceKey) => {
								change(
									current => ({
										...current,
										text: current.text.map(text => (text.id === id ? { ...text, x, y } : text))
									}),
									coalesceKey
								)
							}}
						/>
					</div>
					<div className="flex shrink-0 flex-col gap-2 px-4 pt-2 pb-3 sm:px-6 sm:pb-4">
						<div className="flex items-center gap-0.5 overflow-x-auto">
							<TooltipIconButton
								label={t("previewVideoEditUndo")}
								disabled={!snapshot.canUndo}
								shortcut={<Kbd action="preview.videoUndo" />}
								onClick={undo}
							>
								<Undo2Icon />
							</TooltipIconButton>
							<TooltipIconButton
								label={t("previewVideoEditRedo")}
								disabled={!snapshot.canRedo}
								shortcut={<Kbd action="preview.videoRedo" />}
								onClick={redo}
							>
								<Redo2Icon />
							</TooltipIconButton>
							<Separator
								orientation="vertical"
								className="mx-1 my-1.5 self-stretch"
							/>
							<TooltipIconButton
								label={t("previewVideoEditFrameBack")}
								shortcut={<Kbd action="preview.videoFrameBack" />}
								onClick={() => {
									step(-frameDuration(fps))
								}}
							>
								<SkipBackIcon />
							</TooltipIconButton>
							<TooltipIconButton
								label={t(paused ? "previewVideoEditPlay" : "previewVideoEditPause")}
								shortcut={<Kbd action="preview.videoPlayPause" />}
								onClick={() => {
									playback.toggle()
								}}
							>
								{paused ? <PlayIcon /> : <PauseIcon />}
							</TooltipIconButton>
							<TooltipIconButton
								label={t("previewVideoEditFrameForward")}
								shortcut={<Kbd action="preview.videoFrameForward" />}
								onClick={() => {
									step(frameDuration(fps))
								}}
							>
								<SkipForwardIcon />
							</TooltipIconButton>
							<span
								ref={timecodeRef}
								role="timer"
								aria-label={t("previewVideoEditPosition")}
								className="ml-2 shrink-0 font-mono text-xs text-muted-foreground tabular-nums"
							/>
							<span className="flex-1" />
							<TooltipIconButton
								label={t("previewVideoEditSplit")}
								shortcut={<Kbd action="preview.videoSplit" />}
								onClick={split}
							>
								<SplitIcon />
							</TooltipIconButton>
							<TooltipIconButton
								label={t("previewVideoEditRemoveSection")}
								disabled={selection === null}
								shortcut={<Kbd action="preview.videoRemoveSection" />}
								onClick={removeSelection}
							>
								<ScissorsIcon />
							</TooltipIconButton>
							<TooltipIconButton
								label={t("previewVideoEditLoop")}
								pressed={loop}
								disabled={selection === null}
								shortcut={<Kbd action="preview.videoLoop" />}
								onClick={() => {
									setLoop(!loop)
								}}
							>
								<RepeatIcon />
							</TooltipIconButton>
							<TooltipIconButton
								label={t("previewVideoEditSaveFrame")}
								disabled={!online}
								title={!online ? t("common:offlineActionDisabled") : undefined}
								shortcut={<Kbd action="preview.videoSaveFrame" />}
								onClick={saveFrame}
							>
								<CameraIcon />
							</TooltipIconButton>
							<Separator
								orientation="vertical"
								className="mx-1 my-1.5 self-stretch"
							/>
							<TooltipIconButton
								label={t("previewVideoEditZoomOut")}
								shortcut={<Kbd action="preview.videoZoomOut" />}
								onClick={() => {
									zoom(1 / ZOOM_STEP)
								}}
							>
								<ZoomOutIcon />
							</TooltipIconButton>
							<TooltipIconButton
								label={t("previewVideoEditZoomIn")}
								shortcut={<Kbd action="preview.videoZoomIn" />}
								onClick={() => {
									zoom(ZOOM_STEP)
								}}
							>
								<ZoomInIcon />
							</TooltipIconButton>
						</div>
						<VideoTimeline
							client={client}
							playback={playback}
							duration={duration}
							fps={fps}
							keep={recipe.keep}
							view={view}
							selection={selection}
							splits={shownSplits}
							snaps={snaps}
							locked={exporting}
							onView={setView}
							onSeek={seek}
							onSelect={setSelection}
							onEdge={(index, edge, time, coalesceKey) => {
								change(
									current => ({ ...current, keep: moveKeepEdge(current.keep, index, edge, time, duration) }),
									coalesceKey
								)
							}}
							onScrub={scrub}
							onLoupeCanvas={canvas => {
								loupeRef.current = canvas
							}}
							onMakePrecise={() => {
								change(current => ({ ...current, precise: true }))
							}}
						/>
					</div>
				</div>
				<aside
					aria-label={t("previewVideoEditTools")}
					className="flex h-[38dvh] shrink-0 animate-in flex-col rounded-t-3xl bg-background shadow-[0_-8px_24px_-12px_rgb(0_0_0/0.6)] ring-1 ring-border duration-300 ease-out fade-in-0 slide-in-from-bottom-4 motion-reduce:animate-none sm:my-3 sm:mr-3 sm:h-auto sm:w-80 sm:rounded-3xl sm:shadow-lg sm:slide-in-from-bottom-0 sm:slide-in-from-right-4"
				>
					<span
						aria-hidden="true"
						className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-foreground/20 sm:hidden"
					/>
					<VideoEditPanel
						idBase={idBase}
						tab={tab}
						recipe={recipe}
						info={info}
						unavailable={unavailable}
						hdrBlocked={hdrBlocked}
						selection={selection}
						aspect={aspect}
						selectedText={selectedText}
						thumbnails={thumbnails?.bitmaps ?? null}
						onTab={setTab}
						onChange={change}
						onTrim={(edge, time) => {
							change(current => ({ ...current, keep: setTrim(current.keep, edge, time, duration) }))
							seek(time)
						}}
						onSelection={setSelection}
						onRemoveSelection={removeSelection}
						onRestore={range => {
							change(current => ({ ...current, keep: restoreSection(current.keep, range, duration) }))
						}}
						onAspect={handleAspect}
						onTurn={direction => {
							change(current => turnRecipe(current, direction))
						}}
						onFlip={axis => {
							change(current => flipRecipe(current, axis))
						}}
						onResetCrop={() => {
							setAspect("free")
							change(current => ({ ...current, crop: null, rotate: 0, flipH: false, flipV: false }))
						}}
						onAddText={addText}
						onSelectText={setSelectedText}
					/>
				</aside>
			</div>
		</div>
	)
}
