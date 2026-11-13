import {
	useEffect,
	useRef,
	useState,
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	type RefObject
} from "react"
import { useTranslation } from "react-i18next"
import { cn } from "@filen/shared"
import type { DriveItem } from "@/features/drive/lib/item"
import { usePreviewVideo } from "@/features/preview/hooks/usePreviewVideo"
import { CropOverlay } from "@/features/preview/imageEdit/components/cropOverlay"
import { fitBox, normalisedRatio } from "@/features/preview/imageEdit/components/editorGeometry"
import type { AspectPreset } from "@/features/preview/imageEdit/types"
import type { TextOverlay, VideoEditRecipe, VideoSourceInfo } from "@/features/preview/videoEdit/types"
import {
	croppedSize,
	cropToNormalised,
	playbackLayout,
	rectToView,
	stageRecipe,
	turnedSize,
	type NormalisedRect,
	type StageMode,
	type Size
} from "@/features/preview/videoEdit/lib/recipe"
import { drawBitmap, type FrameRequests } from "@/features/preview/videoEdit/components/frameRequests"
import { PreviewLoading } from "@/features/preview/components/previewErrorState"
import { mediaValue, useMediaValue } from "@/lib/media/useMediaState"
import { useLatestRef } from "@/lib/useLatestRef"

// Text boxes nudge by this much of the frame per arrow key, ten times that with Shift.
const TEXT_NUDGE = 0.01

// The element holds a frame to show (HAVE_CURRENT_DATA).
const HAS_PICTURE = mediaValue(["loadeddata", "emptied", "loadstart"], media => media.readyState >= 2)

export interface VideoStageProps {
	item: DriveItem
	positionKey: string
	info: VideoSourceInfo
	recipe: VideoEditRecipe
	mode: StageMode
	aspect: AspectPreset
	paused: boolean
	// The playhead where it last settled (paused, sought), for the exact frame.
	settledTime: number
	// The same moment on the output timeline, for which text boxes show.
	settledOutputTime: number
	// An export holds the decoder (iOS): no exact frame is asked meanwhile, and it is asked again once it ends.
	decodingSuspended: boolean
	selectedText: string | null
	frames: FrameRequests
	// The exact frame's canvas, shared with the timeline's scrub (which draws into it too).
	canvasRef: RefObject<HTMLCanvasElement | null>
	onVideo: (video: HTMLVideoElement | null) => void
	onCrop: (view: NormalisedRect, coalesceKey: string | undefined) => void
	onSelectText: (id: string) => void
	onMoveText: (id: string, x: number, y: number, coalesceKey: string | undefined) => void
}

interface TextDrag {
	id: string
	pointerX: number
	pointerY: number
	x: number
	y: number
	moved: boolean
	element: HTMLElement
}

// The editor's picture: the preview's own <video> (the same source and route as the player) laid out by CSS to show the
// crop, turn and mirrors while it plays, and, while paused, the exact frame from the client with every edit applied
// (colour and text included) drawn over it. The crop tab's frame and the text tab's boxes sit on top.
export function VideoStage(props: VideoStageProps) {
	const { t } = useTranslation("preview")
	const stageRef = useRef<HTMLDivElement | null>(null)
	const [video, setVideo] = useState<HTMLVideoElement | null>(null)
	const [stage, setStage] = useState<Size>({ width: 0, height: 0 })
	const textDrag = useRef<TextDrag | null>(null)
	// An exact frame from the client was drawn: the picture is there even before the element has one.
	const [frameShown, setFrameShown] = useState(false)
	const { recipe, info, mode, frames, canvasRef } = props
	const { snapshot } = usePreviewVideo(props.item, video, props.positionKey)
	const hasPicture = useMediaValue(video, HAS_PICTURE, false)
	const failed = !frameShown && (snapshot?.status === "failed" || snapshot?.status === "unsupported")
	const loading = !frameShown && !hasPicture && !failed

	const onVideo = props.onVideo

	useEffect(() => {
		onVideo(video)

		return () => {
			onVideo(null)
		}
	}, [video, onVideo])

	useEffect(() => {
		const element = stageRef.current

		if (element === null) {
			return
		}

		const observer = new ResizeObserver(entries => {
			const entry = entries[entries.length - 1]

			if (entry !== undefined) {
				setStage({ width: entry.contentRect.width, height: entry.contentRect.height })
			}
		})

		observer.observe(element)

		return () => {
			observer.disconnect()
		}
	}, [])

	const display: Size = { width: info.width, height: info.height }
	const shown = stageRecipe(recipe, mode)
	const outputSize = mode === "crop" ? turnedSize(recipe.rotate, display) : croppedSize(shown, display)
	const box = fitBox(outputSize, stage)
	const layout = playbackLayout(display, shown.crop, recipe.rotate, recipe.flipH, recipe.flipV, box)
	const frameKey = JSON.stringify(shown)
	const latestRecipe = useLatestRef(shown)

	// The exact frame while paused: asked again when the playhead settles elsewhere, the edits or the box change.
	useEffect(() => {
		const canvas = canvasRef.current

		if (canvas === null) {
			return
		}

		if (!props.paused) {
			canvas.removeAttribute("data-ready")
			frames.clear()

			return
		}

		if (box.width <= 0) {
			return
		}

		frames.request(props.settledTime, latestRecipe.current, box.width * window.devicePixelRatio, bitmap => {
			drawBitmap(canvas, bitmap)
			canvas.setAttribute("data-ready", "")
			setFrameShown(true)
		})
	}, [frames, canvasRef, latestRecipe, props.paused, props.settledTime, frameKey, box.width, props.decodingSuspended])

	const cropView = rectToView(cropToNormalised(recipe.crop, display), recipe.rotate, recipe.flipH, recipe.flipV)

	// ---- Text boxes. ----

	const textPointerDown = (event: ReactPointerEvent<HTMLDivElement>, text: TextOverlay): void => {
		if (event.button !== 0) {
			return
		}

		event.preventDefault()
		event.currentTarget.setPointerCapture(event.pointerId)
		event.currentTarget.focus()
		textDrag.current = {
			id: text.id,
			pointerX: event.clientX,
			pointerY: event.clientY,
			x: text.x,
			y: text.y,
			moved: false,
			element: event.currentTarget
		}
	}

	const textPosition = (event: ReactPointerEvent<HTMLDivElement>, drag: TextDrag): [number, number] => [
		Math.min(1, Math.max(0, drag.x + (event.clientX - drag.pointerX) / Math.max(1, box.width))),
		Math.min(1, Math.max(0, drag.y + (event.clientY - drag.pointerY) / Math.max(1, box.height)))
	]

	const textPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
		const drag = textDrag.current

		if (drag === null) {
			return
		}

		if (!drag.moved && Math.hypot(event.clientX - drag.pointerX, event.clientY - drag.pointerY) < 3) {
			return
		}

		drag.moved = true

		const [x, y] = textPosition(event, drag)

		drag.element.style.left = `${String(x * 100)}%`
		drag.element.style.top = `${String(y * 100)}%`
	}

	const textPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
		const drag = textDrag.current

		textDrag.current = null

		if (drag === null) {
			return
		}

		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId)
		}

		props.onSelectText(drag.id)

		if (drag.moved) {
			const [x, y] = textPosition(event, drag)

			props.onMoveText(drag.id, x, y, undefined)
		}
	}

	const textKey = (event: ReactKeyboardEvent<HTMLDivElement>, text: TextOverlay): void => {
		const step = event.shiftKey ? TEXT_NUDGE * 10 : TEXT_NUDGE
		const delta: Readonly<Record<string, readonly [number, number]>> = {
			ArrowLeft: [-step, 0],
			ArrowRight: [step, 0],
			ArrowUp: [0, -step],
			ArrowDown: [0, step]
		}
		const move = delta[event.key]

		if (move === undefined) {
			return
		}

		event.preventDefault()
		event.stopPropagation()
		props.onMoveText(
			text.id,
			Math.min(1, Math.max(0, text.x + move[0])),
			Math.min(1, Math.max(0, text.y + move[1])),
			`text-move-${text.id}`
		)
	}

	return (
		<div
			ref={stageRef}
			role="group"
			aria-label={t("previewVideoEditStageArea")}
			className="relative size-full"
		>
			<div
				className="absolute overflow-hidden"
				style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
			>
				{/* The picture alone is the image; the crop frame and text boxes over it stay reachable. */}
				<div
					role="img"
					aria-label={t("previewVideoEditStage")}
					className="absolute inset-0"
				>
					<div
						className="absolute overflow-hidden"
						style={{
							left: layout.window.left,
							top: layout.window.top,
							width: layout.window.width,
							height: layout.window.height,
							transform: layout.transform
						}}
					>
						{/* Metadata only: the paused picture is the client's exact frame; the element loads more once it plays. */}
						<video
							ref={setVideo}
							playsInline
							preload="metadata"
							disablePictureInPicture
							className="absolute max-w-none"
							style={{
								left: layout.video.left,
								top: layout.video.top,
								width: layout.video.width,
								height: layout.video.height
							}}
						/>
					</div>
					<canvas
						ref={canvasRef}
						aria-hidden="true"
						className={cn(
							"absolute inset-0 block size-full opacity-0 transition-opacity duration-100 data-ready:opacity-100 motion-reduce:transition-none",
							!props.paused && "hidden"
						)}
					/>
				</div>
				{mode === "text" ? (
					<div className="absolute inset-0">
						{recipe.text.map(text => {
							const active = props.settledOutputTime >= text.startSec && props.settledOutputTime < text.endSec

							return (
								<div
									key={text.id}
									role="button"
									tabIndex={0}
									aria-label={t("previewVideoEditTextBox", { text: text.text })}
									aria-pressed={props.selectedText === text.id}
									className={cn(
										"absolute max-w-full cursor-move touch-none rounded-[0.3em] px-[0.45em] py-[0.15em] leading-tight font-semibold whitespace-pre outline-none select-none",
										props.selectedText === text.id
											? "ring-2 ring-primary"
											: "outline-1 outline-white/50 outline-dashed",
										!active && "opacity-40"
									)}
									style={{
										left: `${String(text.x * 100)}%`,
										top: `${String(text.y * 100)}%`,
										transform: "translate(-50%, -50%)",
										fontSize: Math.max(6, text.size * box.height),
										color: text.color,
										backgroundColor: text.background ? "rgb(0 0 0 / 0.55)" : "transparent",
										fontFamily: "system-ui, sans-serif"
									}}
									onPointerDown={event => {
										textPointerDown(event, text)
									}}
									onPointerMove={textPointerMove}
									onPointerUp={textPointerUp}
									onPointerCancel={() => {
										textDrag.current = null
									}}
									onKeyDown={event => {
										textKey(event, text)
									}}
									onFocus={() => {
										props.onSelectText(text.id)
									}}
								>
									{text.text}
								</div>
							)
						})}
					</div>
				) : null}
			</div>
			{loading ? (
				<div className="pointer-events-none absolute inset-0">
					<PreviewLoading />
				</div>
			) : null}
			{failed ? (
				<p className="absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-destructive">
					{t("previewVideoEditLoadFailed")}
				</p>
			) : null}
			{mode === "crop" ? (
				<CropOverlay
					frame={box}
					crop={cropView}
					ratio={normalisedRatio(props.aspect, outputSize)}
					onCommit={props.onCrop}
				/>
			) : null}
		</div>
	)
}
