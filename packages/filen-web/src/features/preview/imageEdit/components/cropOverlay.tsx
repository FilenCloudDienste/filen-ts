import { useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react"
import { useTranslation } from "react-i18next"
import { cn } from "@filen/shared"
import { dragCrop, type Box, type CropHandle } from "@/features/preview/imageEdit/components/editorGeometry"
import type { Crop } from "@/features/preview/imageEdit/lib/recipe"

// Each handle's hit area is centred on its corner or edge; its mark is drawn from there: an L-shaped bracket hugging
// a corner from outside the frame, a short bar across an edge.
const HANDLES: readonly { handle: Exclude<CropHandle, "move">; labelKey: HandleLabelKey; className: string; mark: string }[] = [
	{
		handle: "nw",
		labelKey: "previewImageEditHandleTopLeft",
		className: "top-0 left-0 cursor-nwse-resize",
		mark: "top-[calc(50%-3px)] left-[calc(50%-3px)] size-5 rounded-tl-[3px] border-t-3 border-l-3"
	},
	{
		handle: "n",
		labelKey: "previewImageEditHandleTop",
		className: "top-0 left-1/2 cursor-ns-resize",
		mark: "top-[calc(50%-3px)] left-1/2 h-1 w-6 -translate-x-1/2 rounded-full bg-white"
	},
	{
		handle: "ne",
		labelKey: "previewImageEditHandleTopRight",
		className: "top-0 left-full cursor-nesw-resize",
		mark: "top-[calc(50%-3px)] right-[calc(50%-3px)] size-5 rounded-tr-[3px] border-t-3 border-r-3"
	},
	{
		handle: "e",
		labelKey: "previewImageEditHandleRight",
		className: "top-1/2 left-full cursor-ew-resize",
		mark: "top-1/2 right-[calc(50%-3px)] h-6 w-1 -translate-y-1/2 rounded-full bg-white"
	},
	{
		handle: "se",
		labelKey: "previewImageEditHandleBottomRight",
		className: "top-full left-full cursor-nwse-resize",
		mark: "right-[calc(50%-3px)] bottom-[calc(50%-3px)] size-5 rounded-br-[3px] border-r-3 border-b-3"
	},
	{
		handle: "s",
		labelKey: "previewImageEditHandleBottom",
		className: "top-full left-1/2 cursor-ns-resize",
		mark: "bottom-[calc(50%-3px)] left-1/2 h-1 w-6 -translate-x-1/2 rounded-full bg-white"
	},
	{
		handle: "sw",
		labelKey: "previewImageEditHandleBottomLeft",
		className: "top-full left-0 cursor-nesw-resize",
		mark: "bottom-[calc(50%-3px)] left-[calc(50%-3px)] size-5 rounded-bl-[3px] border-b-3 border-l-3"
	},
	{
		handle: "w",
		labelKey: "previewImageEditHandleLeft",
		className: "top-1/2 left-0 cursor-ew-resize",
		mark: "top-1/2 left-[calc(50%-3px)] h-6 w-1 -translate-y-1/2 rounded-full bg-white"
	}
]

type HandleLabelKey =
	| "previewImageEditHandleTopLeft"
	| "previewImageEditHandleTop"
	| "previewImageEditHandleTopRight"
	| "previewImageEditHandleRight"
	| "previewImageEditHandleBottomRight"
	| "previewImageEditHandleBottom"
	| "previewImageEditHandleBottomLeft"
	| "previewImageEditHandleLeft"

const KEY_STEP = 0.01
const KEY_STEP_LARGE = 0.1

function applyCropStyle(element: HTMLElement | null, crop: Crop): void {
	if (element === null) {
		return
	}

	element.style.left = `${String(crop.x * 100)}%`
	element.style.top = `${String(crop.y * 100)}%`
	element.style.width = `${String(crop.width * 100)}%`
	element.style.height = `${String(crop.height * 100)}%`
}

// The thirds grid shows while the frame is dragged: flagged on the element, so the gesture re-renders nothing.
function setAdjusting(element: HTMLElement | null, adjusting: boolean): void {
	if (element !== null) {
		element.toggleAttribute("data-adjusting", adjusting)
	}
}

function arrowDelta(event: ReactKeyboardEvent): readonly [number, number] | null {
	const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP

	switch (event.key) {
		case "ArrowLeft":
			return [-step, 0]
		case "ArrowRight":
			return [step, 0]
		case "ArrowUp":
			return [0, -step]
		case "ArrowDown":
			return [0, step]
		default:
			return null
	}
}

// The crop frame over the whole (turned, straightened) picture, positioned at `frame` in the stage. Dragging inside
// moves it, the eight handles resize it; Arrow keys on the focused frame or handle nudge it. A drag moves the frame
// by style alone and commits once, on release, so it re-renders nothing while the pointer moves.
export function CropOverlay(props: {
	frame: Box
	crop: Crop
	// Normalised width over height to keep, or null for free.
	ratio: number | null
	onCommit: (crop: Crop, coalesceKey: string | undefined) => void
}) {
	const { t } = useTranslation("preview")
	const rectRef = useRef<HTMLDivElement | null>(null)
	const shadeRef = useRef<HTMLDivElement | null>(null)
	const drag = useRef<{ handle: CropHandle; pointerX: number; pointerY: number; width: number; height: number; crop: Crop } | null>(null)

	const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
		if (event.button !== 0 || !(event.target instanceof HTMLElement)) {
			return
		}

		const handle = event.target.closest<HTMLElement>("[data-crop-handle]")?.dataset["cropHandle"]

		if (handle === undefined) {
			return
		}

		event.preventDefault()
		event.currentTarget.setPointerCapture(event.pointerId)

		// The one layout read of the gesture.
		const box = event.currentTarget.getBoundingClientRect()

		drag.current = {
			handle: handle as CropHandle,
			pointerX: event.clientX,
			pointerY: event.clientY,
			width: box.width,
			height: box.height,
			crop: props.crop
		}
		setAdjusting(rectRef.current, true)
	}

	const draft = (event: ReactPointerEvent<HTMLDivElement>): Crop | null => {
		const current = drag.current

		if (current === null || current.width <= 0 || current.height <= 0) {
			return null
		}

		return dragCrop(
			current.crop,
			current.handle,
			(event.clientX - current.pointerX) / current.width,
			(event.clientY - current.pointerY) / current.height,
			props.ratio
		)
	}

	const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
		const next = draft(event)

		if (next !== null) {
			applyCropStyle(rectRef.current, next)
			applyCropStyle(shadeRef.current, next)
		}
	}

	const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
		const next = draft(event)

		drag.current = null
		setAdjusting(rectRef.current, false)

		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId)
		}

		if (
			next !== null &&
			(next.x !== props.crop.x || next.y !== props.crop.y || next.width !== props.crop.width || next.height !== props.crop.height)
		) {
			props.onCommit(next, undefined)
		}
	}

	const handlePointerCancel = (event: ReactPointerEvent<HTMLDivElement>): void => {
		drag.current = null
		setAdjusting(rectRef.current, false)

		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId)
		}

		applyCropStyle(rectRef.current, props.crop)
		applyCropStyle(shadeRef.current, props.crop)
	}

	const nudge = (handle: CropHandle, event: ReactKeyboardEvent): void => {
		const delta = arrowDelta(event)

		if (delta === null) {
			return
		}

		// Taken here: the arrows would otherwise scroll, and the overlay's pager ignores keys in the editor.
		event.preventDefault()
		event.stopPropagation()
		props.onCommit(dragCrop(props.crop, handle, delta[0], delta[1], props.ratio), `crop-${handle}`)
	}

	return (
		<div
			className="absolute touch-none select-none"
			style={{ left: props.frame.left, top: props.frame.top, width: props.frame.width, height: props.frame.height }}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerUp}
			onPointerCancel={handlePointerCancel}
		>
			{/* The shade outside the crop is the frame's own spread shadow, clipped to the picture. */}
			<div className="pointer-events-none absolute inset-0 overflow-hidden">
				<div
					className="absolute shadow-[0_0_0_9999px_rgb(0_0_0/0.55)]"
					style={{
						left: `${String(props.crop.x * 100)}%`,
						top: `${String(props.crop.y * 100)}%`,
						width: `${String(props.crop.width * 100)}%`,
						height: `${String(props.crop.height * 100)}%`
					}}
					ref={shadeRef}
				/>
			</div>
			<div
				ref={rectRef}
				role="group"
				tabIndex={0}
				aria-label={t("previewImageEditCropArea")}
				data-crop-handle="move"
				className="group/crop absolute cursor-move ring-1 ring-white/80 outline-none focus-visible:ring-2 focus-visible:ring-white"
				style={{
					left: `${String(props.crop.x * 100)}%`,
					top: `${String(props.crop.y * 100)}%`,
					width: `${String(props.crop.width * 100)}%`,
					height: `${String(props.crop.height * 100)}%`
				}}
				onKeyDown={event => {
					if (event.target === event.currentTarget) {
						nudge("move", event)
					}
				}}
			>
				{/* Rule of thirds, while the frame is dragged or nudged from the keyboard. */}
				<div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3 opacity-0 transition-opacity duration-150 group-focus-visible/crop:opacity-100 group-has-focus-visible/crop:opacity-100 group-data-adjusting/crop:opacity-100 motion-reduce:transition-none">
					{[0, 1, 2, 3, 4, 5, 6, 7, 8].map(cell => (
						<div
							key={cell}
							className="border-white/40 not-nth-[3n]:border-r not-nth-[n+7]:border-b"
						/>
					))}
				</div>
				{HANDLES.map(({ handle, labelKey, className, mark }) => (
					<div
						key={handle}
						role="button"
						tabIndex={0}
						aria-label={t(labelKey)}
						data-crop-handle={handle}
						className={cn(
							"absolute size-8 -translate-1/2 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white/70",
							className
						)}
						onKeyDown={event => {
							nudge(handle, event)
						}}
					>
						<span className={cn("pointer-events-none absolute border-white drop-shadow-[0_0_2px_rgb(0_0_0/0.6)]", mark)} />
					</div>
				))}
			</div>
		</div>
	)
}
