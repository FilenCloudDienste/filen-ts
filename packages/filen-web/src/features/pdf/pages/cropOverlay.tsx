import { useId, useState, type KeyboardEvent, type PointerEvent } from "react"
import { useTranslation } from "react-i18next"
import { dragCropHandle, nudgeCropRect, outsideRects, type CropHandle, type CropRect } from "@filen/office/core/pdfedit/crop"

export interface PdfCropOverlayProps {
	// The page's visible box in points, view space ([0, 0, width, height]).
	readonly bounds: CropRect
	// CSS px per point (the page's zoom).
	readonly scale: number
	// The crop in points, view space.
	readonly rect: CropRect
	readonly onChange: (rect: CropRect) => void
	readonly onCommit: () => void
	readonly onCancel: () => void
}

interface CropDrag {
	readonly handle: CropHandle
	readonly pointerId: number
	readonly x: number
	readonly y: number
	readonly start: CropRect
}

const HANDLES: readonly Exclude<CropHandle, "move">[] = [
	"topLeft",
	"top",
	"topRight",
	"right",
	"bottomRight",
	"bottom",
	"bottomLeft",
	"left"
]
// Arrow keys move by a point, by ten with Shift.
const STEP = 1
const BIG_STEP = 10

function handlePlace(handle: Exclude<CropHandle, "move">): { readonly x: number; readonly y: number } {
	const x = handle.endsWith("Left") || handle === "left" ? 0 : handle.endsWith("Right") || handle === "right" ? 1 : 0.5
	const y = handle.startsWith("top") ? 0 : handle.startsWith("bottom") ? 1 : 0.5

	return { x, y }
}

function cursor(handle: CropHandle): string {
	switch (handle) {
		case "move":
			return "move"
		case "top":
		case "bottom":
			return "ns-resize"
		case "left":
		case "right":
			return "ew-resize"
		case "topLeft":
		case "bottomRight":
			return "nwse-resize"
		case "topRight":
		case "bottomLeft":
			return "nesw-resize"
	}
}

// The crop handles over one page: the outside dimmed, the crop area (drag to move, arrows to move with the keyboard)
// and eight handles (drag, or focus one with Tab and use the arrows). Enter applies, Escape cancels; the crop's
// place in points is announced after each keyboard step. Positioned by the host over the page at its zoom.
export function PdfCropOverlay({ bounds, scale, rect, onChange, onCommit, onCancel }: PdfCropOverlayProps) {
	const { t } = useTranslation("preview")
	const id = useId()
	const [announcement, setAnnouncement] = useState("")
	const [drag, setDrag] = useState<CropDrag | null>(null)
	const px = (value: number): number => value * scale
	const width = rect[2] - rect[0]
	const height = rect[3] - rect[1]
	const labels: Readonly<Record<Exclude<CropHandle, "move">, string>> = {
		top: t("previewPdfCropHandleTop"),
		bottom: t("previewPdfCropHandleBottom"),
		left: t("previewPdfCropHandleLeft"),
		right: t("previewPdfCropHandleRight"),
		topLeft: t("previewPdfCropHandleTopLeft"),
		topRight: t("previewPdfCropHandleTopRight"),
		bottomLeft: t("previewPdfCropHandleBottomLeft"),
		bottomRight: t("previewPdfCropHandleBottomRight")
	}

	const onKeyDown = (handle: CropHandle) => (event: KeyboardEvent<HTMLElement>) => {
		if (event.key === "Enter") {
			event.preventDefault()
			event.stopPropagation()
			onCommit()

			return
		}

		if (event.key === "Escape") {
			event.preventDefault()
			event.stopPropagation()
			onCancel()

			return
		}

		const next = nudgeCropRect(bounds, rect, handle, event.key, event.shiftKey ? BIG_STEP : STEP)

		if (next === undefined) return

		event.preventDefault()
		event.stopPropagation()
		onChange(next)
		setAnnouncement(
			t("previewPdfCropPosition", {
				width: Math.round(next[2] - next[0]),
				height: Math.round(next[3] - next[1]),
				left: Math.round(next[0] - bounds[0]),
				top: Math.round(next[1] - bounds[1])
			})
		)
	}

	const onPointerDown = (handle: CropHandle) => (event: PointerEvent<HTMLElement>) => {
		if (event.button !== 0) return

		event.preventDefault()
		event.stopPropagation()
		event.currentTarget.setPointerCapture(event.pointerId)
		event.currentTarget.focus({ preventScroll: true })
		setDrag({ handle, pointerId: event.pointerId, x: event.clientX, y: event.clientY, start: rect })
	}

	const onPointerMove = (event: PointerEvent<HTMLElement>): void => {
		if (drag?.pointerId !== event.pointerId || scale <= 0) return

		onChange(dragCropHandle(bounds, drag.start, drag.handle, (event.clientX - drag.x) / scale, (event.clientY - drag.y) / scale))
	}

	const onPointerUp = (event: PointerEvent<HTMLElement>): void => {
		if (drag?.pointerId === event.pointerId) setDrag(null)
	}

	const pointer = (handle: CropHandle) => ({
		onPointerDown: onPointerDown(handle),
		onPointerMove,
		onPointerUp,
		onPointerCancel: onPointerUp
	})

	return (
		<div
			className="pointer-events-none absolute inset-0"
			data-pdf-crop-overlay
		>
			{outsideRects(bounds, rect).map(([x0, y0, x1, y1]) => (
				<div
					key={`${String(x0)}-${String(y0)}`}
					className="absolute bg-black/45"
					aria-hidden="true"
					style={{ left: px(x0 - bounds[0]), top: px(y0 - bounds[1]), width: px(x1 - x0), height: px(y1 - y0) }}
				/>
			))}
			<div
				role="group"
				tabIndex={0}
				aria-label={t("previewPdfCropArea")}
				aria-describedby={`${id}-keys`}
				className="pointer-events-auto absolute outline-2 outline-offset-0 outline-white outline-dashed focus-visible:outline-primary"
				style={{
					left: px(rect[0] - bounds[0]),
					top: px(rect[1] - bounds[1]),
					width: px(width),
					height: px(height),
					cursor: cursor("move"),
					touchAction: "none"
				}}
				onKeyDown={onKeyDown("move")}
				{...pointer("move")}
			>
				{HANDLES.map(handle => {
					const place = handlePlace(handle)

					return (
						<button
							key={handle}
							type="button"
							aria-label={labels[handle]}
							aria-describedby={`${id}-keys`}
							data-crop-handle={handle}
							className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-primary bg-background focus-visible:ring-2 focus-visible:ring-primary"
							style={{
								left: `${String(place.x * 100)}%`,
								top: `${String(place.y * 100)}%`,
								cursor: cursor(handle),
								touchAction: "none"
							}}
							onKeyDown={onKeyDown(handle)}
							{...pointer(handle)}
						/>
					)
				})}
			</div>
			<span
				id={`${id}-keys`}
				className="sr-only"
			>
				{t("previewPdfCropKeys")}
			</span>
			<span
				className="sr-only"
				aria-live="polite"
			>
				{announcement}
			</span>
		</div>
	)
}
