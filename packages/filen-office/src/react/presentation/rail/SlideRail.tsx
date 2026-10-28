import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react"
import { slideListRows } from "../../../core/presentation/edit/commands/slide"
import type { Section, SlideRef } from "../../../core/presentation/model"
import type { PresentationThumb } from "../store"
import { dropBefore, dropLineOffset, railKeyTarget, railRows, revealRowOffset, rowRange, thumbnailOrder } from "./window"

// The slide rail: one option per slide, only the ones in view (plus `overscan`) mounted, each drawing its
// thumbnail bitmap into a canvas. Thumbnails are asked for as items come into view; the store skips fresh and
// pending ones. A deck with sections shows each section's name before its slides. An editor adds a multiple
// selection (Shift and Ctrl/Cmd clicks, Shift with the keys), its own keys, and dragging the selection to another
// place with a mouse or pen (touch scrolls the rail; its context menu moves slides). Structure and data-* attributes
// only; the look comes from presentation.css.

export interface SlideRailProps {
	readonly slides: readonly { readonly ref: SlideRef; readonly hidden: boolean }[]
	readonly thumbs: ReadonlyMap<SlideRef, PresentationThumb>
	// Slide height / width.
	readonly aspect: number
	readonly current: number
	readonly onSelect: (index: number) => void
	readonly requestThumbnails: (refs: readonly SlideRef[], widthPx: number) => void
	readonly label: string
	// `section`: the name of the section this slide starts, for its accessible name.
	readonly slideLabel: (index: number, count: number, hidden: boolean, section?: string) => string
	readonly orientation?: "vertical" | "horizontal"
	// CSS px.
	readonly thumbWidth?: number
	readonly overscan?: number
	readonly className?: string
	// The deck's sections: a header before each section's slides.
	readonly sections?: readonly Section[]
	// The slides selected with the current one (indices); absent: the current slide alone.
	readonly selected?: ReadonlySet<number>
	// Shift (a range from the current slide) or Ctrl/Cmd (a toggle) on a click, Shift with a key.
	readonly onExtend?: (index: number, mode: "range" | "toggle") => void
	// The selection dropped to stand before this slide index (the slide count: at the end).
	readonly onMove?: (before: number) => void
	// The host's keys, before the rail's own: true when it handled the key.
	readonly onCommandKey?: (event: KeyboardEvent<HTMLDivElement>) => boolean
}

export const DEFAULT_THUMB_WIDTH = 160
// Space between items along the rail (px); presentation.css draws the item inside its extent.
export const RAIL_ITEM_GAP = 12
// A section header's extent along the rail (px).
export const RAIL_HEADER_EXTENT = 28
export const RAIL_HEADER_EXTENT_HORIZONTAL = 24
// How far a mouse moves with its button down before a press becomes a drag (px).
const DRAG_START = 5
// The band at either end of the rail that scrolls it during a drag (px), and how far it scrolls per frame.
const EDGE = 32
const EDGE_STEP = 16

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

		// A size written again resets the canvas and its layout even when it is the same: only a new one is written.
		if (canvas.width !== thumb.bitmap.width || canvas.height !== thumb.bitmap.height) {
			canvas.width = thumb.bitmap.width
			canvas.height = thumb.bitmap.height
		} else context.clearRect(0, 0, canvas.width, canvas.height)

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

// A press on an item that may become a drag, and the drag once it did.
interface Press {
	readonly pointerId: number
	readonly index: number
	readonly x: number
	readonly y: number
	dragging: boolean
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
	className,
	sections,
	selected,
	onExtend,
	onMove,
	onCommandKey
}: SlideRailProps) {
	const vertical = orientation !== "horizontal"
	const thumbWidth = Math.max(16, Math.round(thumbWidthProp ?? DEFAULT_THUMB_WIDTH))
	const thumbHeight = Math.max(9, Math.round(thumbWidth * (aspect > 0 && Number.isFinite(aspect) ? aspect : 0.5625)))
	const extent = (vertical ? thumbHeight : thumbWidth) + RAIL_ITEM_GAP
	const headerExtent = vertical ? RAIL_HEADER_EXTENT : RAIL_HEADER_EXTENT_HORIZONTAL
	const overscan = Math.max(0, overscanProp ?? 3)
	const count = slides.length
	const containerRef = useRef<HTMLDivElement | null>(null)
	const [viewport, setViewport] = useState({ offset: 0, size: 0 })
	const [drop, setDrop] = useState<number | undefined>(undefined)
	const press = useRef<Press | undefined>(undefined)
	// A drag just ended: the click its release fires selects nothing.
	const dragged = useRef(false)
	const edgeScroll = useRef<{ frame: number; speed: number }>({ frame: 0, speed: 0 })
	const ids = useId()
	const rows = railRows(
		slideListRows(
			slides.map(slide => slide.ref),
			sections ?? []
		),
		count,
		extent,
		headerExtent
	)
	const total = rows.starts[rows.items.length] ?? 0
	const range = rowRange(rows, viewport.offset, viewport.size, overscan)
	const visible = rowRange(rows, viewport.offset, viewport.size, 0)
	const selectedIndex = Math.max(0, Math.min(count - 1, current))
	const currentRow = rows.rowOf[selectedIndex] ?? -1

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

		if (container === null || count === 0 || currentRow < 0) return

		const offset = vertical ? container.scrollTop : container.scrollLeft
		const size = vertical ? container.clientHeight : container.clientWidth
		const target = revealRowOffset(rows, currentRow, offset, size)

		if (target === undefined) return

		if (vertical) container.scrollTop = target
		else container.scrollLeft = target
	}, [currentRow, total, vertical, count])

	// Thumbnails for what is mounted, at device pixels: the items in view first, then the overscan nearest first.
	useEffect(() => {
		if (range.last < range.first) return

		const refs: SlideRef[] = []

		for (const row of thumbnailOrder(range, visible)) {
			const slide = slides[rows.items[row] ?? -1]

			if (slide !== undefined) refs.push(slide.ref)
		}

		requestThumbnails(refs, thumbWidth * devicePixelRatio())
	}, [range.first, range.last, visible.first, visible.last, slides, sections, thumbs, thumbWidth, requestThumbnails])

	useEffect(
		() => () => {
			if (edgeScroll.current.frame !== 0) cancelAnimationFrame(edgeScroll.current.frame)
		},
		[]
	)

	const optionId = (index: number): string => `${ids}-slide-${String(index)}`
	const isSelected = (index: number): boolean => index === selectedIndex || selected?.has(index) === true

	// A pointer's position along the rail's content.
	const along = (event: { readonly clientX: number; readonly clientY: number }): number => {
		const container = containerRef.current

		if (container === null) return 0

		const box = container.getBoundingClientRect()

		return vertical ? event.clientY - box.top + container.scrollTop : event.clientX - box.left + container.scrollLeft
	}

	const stopEdgeScroll = (): void => {
		if (edgeScroll.current.frame !== 0) cancelAnimationFrame(edgeScroll.current.frame)

		edgeScroll.current = { frame: 0, speed: 0 }
	}

	const updateEdgeScroll = (event: { readonly clientX: number; readonly clientY: number }): void => {
		const container = containerRef.current

		if (container === null) return

		const box = container.getBoundingClientRect()
		const position = vertical ? event.clientY - box.top : event.clientX - box.left
		const size = vertical ? box.height : box.width

		edgeScroll.current.speed = position < EDGE ? -EDGE_STEP : position > size - EDGE ? EDGE_STEP : 0

		if (edgeScroll.current.speed === 0 || edgeScroll.current.frame !== 0) return

		const step = (): void => {
			const now = containerRef.current

			if (now === null || edgeScroll.current.speed === 0) {
				edgeScroll.current.frame = 0

				return
			}

			if (vertical) now.scrollTop += edgeScroll.current.speed
			else now.scrollLeft += edgeScroll.current.speed

			edgeScroll.current.frame = requestAnimationFrame(step)
		}

		edgeScroll.current.frame = requestAnimationFrame(step)
	}

	const endPress = (): void => {
		press.current = undefined
		stopEdgeScroll()
		setDrop(undefined)
	}

	const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
		const held = press.current

		if (held === undefined || held.pointerId !== event.pointerId || onMove === undefined) return

		if (!held.dragging) {
			if (Math.hypot(event.clientX - held.x, event.clientY - held.y) < DRAG_START) return

			held.dragging = true
			containerRef.current?.setPointerCapture(event.pointerId)

			// A slide dragged from outside the selection is dragged alone.
			if (!isSelected(held.index)) onSelect(held.index)
		}

		const before = dropBefore(rows, count, along(event))

		setDrop(previous => (previous === before ? previous : before))
		updateEdgeScroll(event)
	}

	const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
		const held = press.current

		if (held === undefined || held.pointerId !== event.pointerId) return

		if (held.dragging) {
			// The click this release makes (on the item or, with the pointer captured, on the list) is not a selection;
			// cleared after this task, so it never swallows the next real click.
			dragged.current = true
			setTimeout(() => {
				dragged.current = false
			}, 0)
			onMove?.(dropBefore(rows, count, along(event)))
		}

		endPress()
	}

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (event.key === "Escape" && press.current?.dragging === true) {
			event.preventDefault()
			endPress()

			return
		}

		if (onCommandKey?.(event) === true) return

		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault()
			onSelect(selectedIndex)

			return
		}

		const page = Math.max(1, Math.floor(viewport.size / extent))
		const target = railKeyTarget(event.key, selectedIndex, count, page, vertical)

		if (target === undefined || event.altKey || event.ctrlKey || event.metaKey) return

		event.preventDefault()

		if (event.shiftKey && onExtend !== undefined) onExtend(target, "range")
		else if (target !== selectedIndex) onSelect(target)
	}

	// The name of the section each section's first slide starts.
	const startsSection = new Map<number, string>()

	if (sections !== undefined && sections.length > 0) {
		for (let row = 0; row + 1 < rows.items.length; row++) {
			const item = rows.items[row] ?? 0
			const next = rows.items[row + 1] ?? -1

			if (item < 0 && next >= 0) startsSection.set(next, sections[-1 - item]?.name ?? "")
		}
	}

	const items: ReactNode[] = []
	const mount = (row: number): void => {
		const item = rows.items[row]
		const position = rows.starts[row] ?? 0
		const size = (rows.starts[row + 1] ?? position) - position
		const place = vertical ? { top: position, height: size } : { left: position, width: size }

		if (item === undefined) return

		if (item < 0) {
			items.push(
				<div
					key={`section-${String(-1 - item)}`}
					className="fo-slide-rail-section"
					role="none"
					aria-hidden="true"
					data-fo-section={-1 - item}
					style={place}
				>
					<span className="fo-slide-rail-section-name">{sections?.[-1 - item]?.name ?? ""}</span>
				</div>
			)

			return
		}

		const slide = slides[item]

		if (slide === undefined) return

		const section = startsSection.get(item)

		items.push(
			<div
				key={slide.ref}
				id={optionId(item)}
				role="option"
				className="fo-slide-rail-item"
				aria-selected={isSelected(item)}
				aria-current={item === selectedIndex ? "true" : undefined}
				aria-posinset={item + 1}
				aria-setsize={count}
				aria-label={section === undefined ? slideLabel(item, count, slide.hidden) : slideLabel(item, count, slide.hidden, section)}
				data-fo-hidden={slide.hidden ? "" : undefined}
				data-fo-index={item}
				style={place}
				onPointerDown={event => {
					if (onMove !== undefined && event.button === 0 && event.pointerType !== "touch") {
						press.current = { pointerId: event.pointerId, index: item, x: event.clientX, y: event.clientY, dragging: false }
					}
				}}
				onClick={event => {
					if (dragged.current) {
						dragged.current = false

						return
					}

					if (onExtend !== undefined && event.shiftKey) onExtend(item, "range")
					else if (onExtend !== undefined && (event.ctrlKey || event.metaKey)) onExtend(item, "toggle")
					else onSelect(item)
				}}
			>
				<span
					className="fo-slide-rail-number"
					aria-hidden="true"
				>
					{item + 1}
				</span>
				<RailThumb
					thumb={thumbs.get(slide.ref)}
					width={thumbWidth}
					height={thumbHeight}
				/>
			</div>
		)
	}

	for (let row = range.first; row <= range.last; row++) mount(row)

	// The active descendant is always mounted, wherever the view is.
	if (count > 0 && currentRow >= 0 && (currentRow < range.first || currentRow > range.last)) mount(currentRow)

	const line = drop === undefined ? undefined : dropLineOffset(rows, drop)

	return (
		<div
			ref={containerRef}
			className={className === undefined ? "fo-slide-rail" : `fo-slide-rail ${className}`}
			data-fo-orientation={vertical ? "vertical" : "horizontal"}
			data-fo-dragging={drop === undefined ? undefined : ""}
			role="listbox"
			aria-label={label}
			aria-orientation={vertical ? "vertical" : "horizontal"}
			aria-multiselectable={selected === undefined ? undefined : true}
			aria-activedescendant={count === 0 ? undefined : optionId(selectedIndex)}
			tabIndex={0}
			onKeyDown={onKeyDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={endPress}
		>
			<div
				className="fo-slide-rail-content"
				role="none"
				style={vertical ? { height: total, width: "100%" } : { width: total, height: "100%" }}
			>
				{items}
				{line === undefined ? null : (
					<div
						className="fo-slide-rail-drop"
						aria-hidden="true"
						style={vertical ? { top: Math.max(0, line - 1) } : { left: Math.max(0, line - 1) }}
					/>
				)}
			</div>
		</div>
	)
}
