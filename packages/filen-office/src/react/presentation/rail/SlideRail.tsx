import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import type { SlideRef } from "../../../core/presentation/model"
import type { PresentationThumb } from "../store"
import { railKeyTarget, railRange, revealOffset, thumbnailOrder } from "./window"

// The slide rail: one option per slide, only the ones in view (plus `overscan`) mounted, each drawing its
// thumbnail bitmap into a canvas. Thumbnails are asked for as items come into view; the store skips fresh and
// pending ones. Structure and data-* attributes only; the look comes from presentation.css.

export interface SlideRailProps {
	readonly slides: readonly { readonly ref: SlideRef; readonly hidden: boolean }[]
	readonly thumbs: ReadonlyMap<SlideRef, PresentationThumb>
	// Slide height / width.
	readonly aspect: number
	readonly current: number
	readonly onSelect: (index: number) => void
	readonly requestThumbnails: (refs: readonly SlideRef[], widthPx: number) => void
	readonly label: string
	readonly slideLabel: (index: number, count: number, hidden: boolean) => string
	readonly orientation?: "vertical" | "horizontal"
	// CSS px.
	readonly thumbWidth?: number
	readonly overscan?: number
	readonly className?: string
}

export const DEFAULT_THUMB_WIDTH = 160
// Space between items along the rail (px); presentation.css draws the item inside its extent.
export const RAIL_ITEM_GAP = 12

function devicePixelRatio(): number {
	const ratio: unknown = Reflect.get(globalThis, "devicePixelRatio")

	return typeof ratio === "number" && ratio > 0 ? Math.min(ratio, 3) : 1
}

function RailThumb(props: { readonly thumb: PresentationThumb | undefined; readonly width: number; readonly height: number }) {
	const { thumb, width, height } = props
	const canvasRef = useRef<HTMLCanvasElement | null>(null)

	useLayoutEffect(() => {
		const canvas = canvasRef.current

		if (canvas === null || thumb === undefined) return

		const context = canvas.getContext("2d")

		if (context === null) return

		canvas.width = thumb.bitmap.width
		canvas.height = thumb.bitmap.height
		context.drawImage(thumb.bitmap as unknown as CanvasImageSource, 0, 0)
	}, [thumb])

	return (
		<span
			className="fo-slide-rail-thumb"
			data-fo-pending={thumb === undefined ? "" : undefined}
			style={{ width, height }}
		>
			{thumb === undefined ? null : (
				<canvas
					ref={canvasRef}
					className="fo-slide-rail-canvas"
					aria-hidden="true"
				/>
			)}
		</span>
	)
}

export function SlideRail({
	slides,
	thumbs,
	aspect,
	current,
	onSelect,
	requestThumbnails,
	label,
	slideLabel,
	orientation,
	thumbWidth: thumbWidthProp,
	overscan: overscanProp,
	className
}: SlideRailProps) {
	const vertical = orientation !== "horizontal"
	const thumbWidth = Math.max(16, Math.round(thumbWidthProp ?? DEFAULT_THUMB_WIDTH))
	const thumbHeight = Math.max(9, Math.round(thumbWidth * (aspect > 0 && Number.isFinite(aspect) ? aspect : 0.5625)))
	const extent = (vertical ? thumbHeight : thumbWidth) + RAIL_ITEM_GAP
	const overscan = Math.max(0, overscanProp ?? 3)
	const count = slides.length
	const containerRef = useRef<HTMLDivElement | null>(null)
	const [viewport, setViewport] = useState({ offset: 0, size: 0 })
	const ids = useId()
	const range = railRange(count, extent, viewport.offset, viewport.size, overscan)
	const visible = railRange(count, extent, viewport.offset, viewport.size, 0)
	const selected = Math.max(0, Math.min(count - 1, current))

	useEffect(() => {
		const container = containerRef.current

		if (container === null) return

		let frame = 0
		const read = (): void => {
			frame = 0

			const offset = vertical ? container.scrollTop : container.scrollLeft
			const size = vertical ? container.clientHeight : container.clientWidth

			setViewport(previous => (previous.offset === offset && previous.size === size ? previous : { offset, size }))
		}
		const schedule = (): void => {
			if (frame === 0) frame = requestAnimationFrame(read)
		}
		const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : undefined

		read()
		container.addEventListener("scroll", schedule, { passive: true })
		observer?.observe(container)

		return () => {
			container.removeEventListener("scroll", schedule)
			observer?.disconnect()

			if (frame !== 0) cancelAnimationFrame(frame)
		}
	}, [vertical])

	// The current slide stays in view when it changes (keys, the canvas, a jump).
	useLayoutEffect(() => {
		const container = containerRef.current

		if (container === null || count === 0) return

		const offset = vertical ? container.scrollTop : container.scrollLeft
		const size = vertical ? container.clientHeight : container.clientWidth
		const target = revealOffset(selected, extent, offset, size)

		if (target === undefined) return

		if (vertical) container.scrollTop = target
		else container.scrollLeft = target
	}, [selected, extent, vertical, count])

	// Thumbnails for what is mounted, at device pixels: the items in view first, then the overscan nearest first.
	useEffect(() => {
		if (range.last < range.first) return

		const refs: SlideRef[] = []

		for (const index of thumbnailOrder(range, visible)) {
			const slide = slides[index]

			if (slide !== undefined) refs.push(slide.ref)
		}

		requestThumbnails(refs, thumbWidth * devicePixelRatio())
	}, [range.first, range.last, visible.first, visible.last, slides, thumbs, thumbWidth, requestThumbnails])

	const optionId = (index: number): string => `${ids}-slide-${String(index)}`

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault()
			onSelect(selected)

			return
		}

		const page = Math.max(1, Math.floor(viewport.size / extent))
		const target = railKeyTarget(event.key, selected, count, page, vertical)

		if (target === undefined) return

		event.preventDefault()

		if (target !== selected) onSelect(target)
	}

	const items: ReactNode[] = []
	const item = (index: number): void => {
		const slide = slides[index]

		if (slide === undefined) return

		const position = index * extent

		items.push(
			<div
				key={slide.ref}
				id={optionId(index)}
				role="option"
				className="fo-slide-rail-item"
				aria-selected={index === selected}
				aria-posinset={index + 1}
				aria-setsize={count}
				aria-label={slideLabel(index, count, slide.hidden)}
				data-fo-hidden={slide.hidden ? "" : undefined}
				data-fo-index={index}
				style={vertical ? { top: position, height: extent } : { left: position, width: extent }}
				onClick={() => onSelect(index)}
			>
				<span
					className="fo-slide-rail-number"
					aria-hidden="true"
				>
					{index + 1}
				</span>
				<RailThumb
					thumb={thumbs.get(slide.ref)}
					width={thumbWidth}
					height={thumbHeight}
				/>
			</div>
		)
	}

	for (let index = range.first; index <= range.last; index++) item(index)

	// The active descendant is always mounted, wherever the view is.
	if (count > 0 && (selected < range.first || selected > range.last)) item(selected)

	return (
		<div
			ref={containerRef}
			className={className === undefined ? "fo-slide-rail" : `fo-slide-rail ${className}`}
			data-fo-orientation={vertical ? "vertical" : "horizontal"}
			role="listbox"
			aria-label={label}
			aria-orientation={vertical ? "vertical" : "horizontal"}
			aria-activedescendant={count === 0 ? undefined : optionId(selected)}
			tabIndex={0}
			onKeyDown={onKeyDown}
		>
			<div
				className="fo-slide-rail-content"
				role="none"
				style={vertical ? { height: count * extent, width: "100%" } : { width: count * extent, height: "100%" }}
			>
				{items}
			</div>
		</div>
	)
}
