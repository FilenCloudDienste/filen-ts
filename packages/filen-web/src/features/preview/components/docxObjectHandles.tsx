import { isImeKeydown } from "@filen/shared/keymap"
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react"
import type { DocxDrawingContext, DocxEditorCommand } from "@filen/office/core/docx/edit"
import { hitObject, type PagedEditor } from "@filen/office/core/docx/paged"
import {
	CropDrag,
	DRAWING_HANDLES,
	DrawingDrag,
	handlePoints,
	type DocxObjectPress,
	type DocxPageOverlay,
	type DrawingHandle,
	type PageBox
} from "@filen/office/react/docx/editor"
import type { DocxObjectControlProps } from "@/features/preview/components/docxFormControls"
import { drawingCrop, useDrawingCrop } from "@/features/preview/components/docxDrawingCrop"

export interface DocxObjectHandlesProps {
	// The page drawn over, in its own coordinates (DocxEditor `overlays`).
	page: DocxPageOverlay
	editor: PagedEditor
	press: DocxObjectPress | null
	readOnly: boolean
	execute: (command: DocxEditorCommand) => void
}

// ---- handles ---------------------------------------------------------------------------------------------

const HANDLE_PREFIX = "handle:"

function pressHandle(part: string | undefined): DrawingHandle | undefined {
	const name = part?.startsWith(HANDLE_PREFIX) === true ? part.slice(HANDLE_PREFIX.length) : undefined

	return DRAWING_HANDLES.find(handle => handle === name)
}

interface Frame {
	readonly story: number
	readonly pos: number
	readonly box: PageBox
}

// A drag under way: the box shown meanwhile, the whole picture's while cropping.
interface Preview {
	readonly box: PageBox
	readonly picture?: PageBox
}

type Drag = DrawingDrag | CropDrag

// Follows one pointer from its press to its release: the drag's box meanwhile, its command after (Escape or a
// cancelled pointer runs none).
function follow(
	drag: Drag,
	start: { clientX: number; clientY: number; pointerId: number },
	zoom: number,
	onMove: (preview: Preview) => void,
	onEnd: (command: DocxEditorCommand | undefined, box: PageBox) => void
): void {
	let box = drag.from
	const move = (event: PointerEvent): void => {
		if (event.pointerId !== start.pointerId) {
			return
		}

		const dx = (event.clientX - start.clientX) / zoom
		const dy = (event.clientY - start.clientY) / zoom

		box = drag instanceof CropDrag ? drag.move(dx, dy) : drag.move(dx, dy, event.shiftKey)
		onMove(drag instanceof CropDrag ? { box, picture: drag.picture } : { box })
	}
	const finish = (command: DocxEditorCommand | undefined): void => {
		window.removeEventListener("pointermove", move)
		window.removeEventListener("pointerup", up)
		window.removeEventListener("pointercancel", cancel)
		window.removeEventListener("keydown", key, true)
		window.removeEventListener("pointerdown", down, true)
		onEnd(command, box)
	}
	const up = (event: PointerEvent): void => {
		if (event.pointerId === start.pointerId) {
			finish(drag.end())
		}
	}
	const cancel = (event: PointerEvent): void => {
		if (event.pointerId === start.pointerId) {
			finish(undefined)
		}
	}
	const key = (event: KeyboardEvent): void => {
		if (event.key === "Escape" && !isImeKeydown(event)) {
			event.preventDefault()
			event.stopPropagation()
			finish(undefined)
		}
	}
	// A new press while this one is followed: its release was missed.
	const down = (): void => {
		finish(undefined)
	}

	window.addEventListener("pointerdown", down, true)
	window.addEventListener("pointermove", move)
	window.addEventListener("pointerup", up)
	window.addEventListener("pointercancel", cancel)
	window.addEventListener("keydown", key, true)
}

// The frame a press on a picture on page `page` shows.
function pressedFrame(press: DocxObjectPress | null, page: number): Frame | null {
	return press?.hit.kind === "drawing" && press.page === page && press.hit.box !== undefined
		? { story: press.hit.story, pos: press.hit.pos, box: press.hit.box }
		: null
}

interface DragTarget {
	readonly drawing: DocxDrawingContext
	readonly box: PageBox
	readonly handle: DrawingHandle | undefined
	readonly crop: boolean
}

interface DragOutput {
	readonly zoom: number
	readonly execute: (command: DocxEditorCommand) => void
	readonly setPreview: (preview: Preview | null) => void
	// The frame's box once a move or resize is done.
	readonly setBox: (box: PageBox) => void
}

// Drags `target` from the press `start`, when it can be dragged so.
function startDrag(target: DragTarget, start: { clientX: number; clientY: number; pointerId: number }, output: DragOutput): void {
	const drag = target.crop
		? new CropDrag(target.drawing, target.box, target.handle)
		: new DrawingDrag(target.drawing, target.box, target.handle)

	if (!drag.active) {
		return
	}

	follow(drag, start, output.zoom, output.setPreview, (command, end) => {
		output.setPreview(null)

		if (command === undefined) {
			return
		}

		output.execute(command)

		if (!target.crop) {
			output.setBox(end)
		}
	})
}

// The selected picture's frame on this page with its resize handles (or, in crop mode, its crop handles over
// the whole picture shaded): a press on a picture selects it; a handle, or a selected floating picture's body,
// drags; the drag shows as the frame moving and ends with one command. Pages only: Mobile view has no handles.
export function DocxObjectHandles({ page, editor, press, readOnly, execute }: DocxObjectHandlesProps) {
	const drawing = useSyncExternalStore(
		listener => editor.subscribe(listener),
		() => editor.snapshot().context.drawing
	)
	const crop = useDrawingCrop(execute)
	const [frame, setFrame] = useState(() => pressedFrame(press, page.index))
	const [preview, setPreview] = useState<Preview | null>(null)
	const [seenPress, setSeenPress] = useState(press)

	// A press on a picture on this page puts the frame where the press found it.
	if (press !== seenPress) {
		setSeenPress(press)

		const pressed = pressedFrame(press, page.index)

		if (pressed !== null) {
			setFrame(pressed)
		}
	}

	const shown = frame !== null && drawing !== null && drawing.pos === frame.pos && editor.activeStory === frame.story ? frame : null
	// The press last acted on: each is acted on once, whatever else the effect below sees change.
	const handledRef = useRef<DocxObjectPress | null>(null)
	const output: DragOutput = {
		zoom: page.zoom,
		execute,
		setPreview,
		setBox: box => {
			setFrame(previous => (previous === null ? null : { ...previous, box }))
		}
	}

	// The press selects the picture; a press on a handle, or on the body of the picture already selected, drags.
	useEffect(() => {
		if (press === handledRef.current || press?.hit.kind !== "drawing" || press.page !== page.index) {
			return
		}

		handledRef.current = press

		const hit = press.hit
		const body = editor.body.session.story.story.index

		if (hit.story !== editor.activeStory) {
			if (hit.story !== body) {
				return
			}

			editor.exitStory()
		}

		const selection = editor.selection()
		const selected = selection.node && selection.from === hit.pos

		if (!selected) {
			editor.select({ pos: hit.pos, affinity: 1, page: page.index, line: 0, atom: true })
		}

		const current = editor.snapshot().context.drawing
		const handle = pressHandle(hit.part)

		if (readOnly || current?.pos !== hit.pos || hit.box === undefined || (!selected && handle === undefined)) {
			return
		}

		startDrag({ drawing: current, box: hit.box, handle, crop: drawingCrop(execute) === hit.pos }, press, {
			zoom: page.zoom,
			execute,
			setPreview,
			setBox: box => {
				setFrame(previous => (previous === null ? null : { ...previous, box }))
			}
		})
	}, [press, page.index, page.zoom, editor, readOnly, execute])

	// The frame follows layout (a resize, an edit before an inline picture): found again at its middle.
	useEffect(() => {
		if (shown === null) {
			return
		}

		return editor.subscribe(event => {
			if (event.type !== "pages" || !event.changed.includes(page.index)) {
				return
			}

			setFrame(previous => {
				if (previous === null) {
					return null
				}

				const hit = hitObject(
					editor,
					page.index,
					previous.box.x + previous.box.width / 2,
					previous.box.y + previous.box.height / 2,
					page.zoom
				)

				return hit?.kind === "drawing" && hit.pos === previous.pos && hit.box !== undefined
					? { ...previous, box: hit.box }
					: previous
			})
		})
	}, [shown, editor, page.index, page.zoom])

	if (shown === null || drawing === null) {
		return null
	}

	const cropMode = crop === drawing.pos && drawing.croppable && !readOnly
	const box = preview?.box ?? shown.box
	const picture = cropMode ? (preview?.picture ?? new CropDrag(drawing, shown.box, undefined).picture) : undefined
	const handles = !readOnly && (cropMode || drawing.resizable) ? handlePoints(box) : []
	const style = {
		"--fo-object-frame": "var(--primary)",
		"--fo-handle-stroke": "var(--primary)",
		"--fo-handle-fill": "var(--background)",
		"--fo-handle-size": `${String(8 / page.zoom)}px`,
		"--fo-crop-handle-size": `${String(12 / page.zoom)}px`,
		"--fo-crop-handle-fill": "var(--foreground)",
		"--fo-crop-shade": "color-mix(in oklab, var(--foreground) 18%, transparent)"
	} as CSSProperties
	const handleDown = (handle: DrawingHandle | undefined) => (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) {
			return
		}

		event.preventDefault()
		event.stopPropagation()
		startDrag({ drawing, box: shown.box, handle, crop: cropMode }, event, output)
	}

	return (
		<div
			data-docx-object-handles
			style={style}
		>
			{picture === undefined ? null : (
				<div
					data-fo-crop-picture
					style={{ left: picture.x, top: picture.y, width: picture.width, height: picture.height }}
					onPointerDown={handleDown(undefined)}
				/>
			)}
			<div
				data-fo-object-frame
				style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
			/>
			{handles.map(point => (
				<div
					key={point.handle}
					{...(cropMode ? { "data-fo-crop-handle": point.handle } : { "data-fo-handle": point.handle })}
					style={{ left: point.x, top: point.y }}
					onPointerDown={handleDown(point.handle)}
				/>
			))}
		</div>
	)
}

// A press on a picture in Mobile view selects it (the Picture group then shows, without resizing or cropping).
export function DocxDrawingPress({ editor, surface, press, onPressDone }: DocxObjectControlProps) {
	useEffect(() => {
		if (press?.hit.kind !== "drawing" || surface !== "reflow") {
			return
		}

		if (press.hit.story === editor.activeStory) {
			editor.select({ pos: press.hit.pos, affinity: 1, page: -1, line: 0, atom: true })
		}

		onPressDone()
	}, [press, surface, editor, onPressDone])

	return null
}
