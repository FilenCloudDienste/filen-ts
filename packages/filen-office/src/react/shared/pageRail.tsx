import {
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
	type CSSProperties,
	type KeyboardEvent,
	type PointerEvent,
	type ReactNode
} from "react"
import {
	dropBefore,
	dropCell,
	dropLineOffset,
	itemRows,
	railKeyTarget,
	railRows,
	revealRowOffset,
	rowRange,
	thumbnailOrder,
	type RailRows
} from "./railWindow"

// A virtualised list (or grid) of thumbnails: the slide rail, a PDF's pages rail and its Organise grid. One option per
// item, only the rows in view (plus `overscan`) mounted; the host draws each item's content (number, thumbnail, hover
// actions) and is told which items are mounted, in priority order, so it renders thumbnails for those only and may
// drop every other one (at most the rows in view plus 2 × overscan stay alive).
//
// Selection and keys: a click selects, Shift extends a range from the current item, Ctrl/Cmd toggles, Shift with the
// arrows extends; with the matching callbacks Space toggles the current item, Mod+A selects all, Alt with the arrows
// moves the selection (Alt+up/down along a rail, Alt+any arrow in a grid), Delete deletes; a mouse or pen drags the
// selection to another place (touch scrolls), and a marquee dragged from the background selects the items it
// touches. A polite live region reads the host's announcement ("Page 3 moved to position 2"). Focus is either kept on
// the listbox with aria-activedescendant (the slide rail) or roved onto the current option (tabindex 0 on it, -1 on
// the others). Structure and data-* attributes only; the look comes from the host's CSS under `classPrefix`.

export interface PageRailHeaderRow {
	readonly kind: "section"
	readonly section: number
}

export interface PageRailItemRow {
	readonly kind: "slide"
	readonly index: number
}

export interface PageRailProps {
	readonly count: number
	// A stable key per item (a slide ref, a page id): a moved item keeps its mounted thumbnail.
	readonly itemKey: (index: number) => string | number
	// Thumbnail height / width.
	readonly aspect: number
	readonly current: number
	readonly onSelect: (index: number) => void
	readonly label: string
	readonly itemLabel: (index: number, count: number) => string
	// What an option shows; `size` is the thumbnail's (CSS px).
	readonly renderItem: (index: number, size: { readonly width: number; readonly height: number }) => ReactNode
	// The mounted items, the ones in view first, then the overscan nearest first, the thumbnail width in device
	// pixels, and how many of the items lead the list because they are in view. Called when they change and on every
	// render that changes `thumbsVersion`.
	readonly onWindow?: (indices: readonly number[], widthPx: number, inView: number) => void
	readonly thumbsVersion?: unknown
	readonly orientation?: "vertical" | "horizontal"
	// A grid (vertical only) fits as many columns as the width holds.
	readonly layout?: "list" | "grid"
	// CSS px.
	readonly thumbWidth?: number
	// In a grid, what an item adds to its thumbnail's width (padding, number): its cell is thumbWidth + this.
	readonly cellChrome?: number
	// Space between rows along the rail (px); the CSS draws the item inside its extent.
	readonly gap?: number
	readonly overscan?: number
	readonly className?: string
	readonly classPrefix?: string
	readonly focusMode?: "activedescendant" | "roving"
	// Item and header rows (sections); absent: the items alone.
	readonly rows?: readonly (PageRailHeaderRow | PageRailItemRow)[]
	readonly headerExtent?: number
	readonly renderHeader?: (section: number) => ReactNode
	// Extra attributes per option (data-*).
	readonly itemAttributes?: (index: number) => Readonly<Record<string, string | undefined>>
	// The items selected with the current one; absent: the current item alone.
	readonly selected?: ReadonlySet<number>
	// Shift (a range from the current item) or Ctrl/Cmd (a toggle) on a click, Shift with a key.
	readonly onExtend?: (index: number, mode: "range" | "toggle") => void
	// The selection dropped to stand before this index (the count: at the end).
	readonly onMove?: (before: number) => void
	// The host's keys, before the rail's own: true when it handled the key.
	readonly onCommandKey?: (event: KeyboardEvent<HTMLDivElement>) => boolean
	readonly onToggle?: (index: number) => void
	readonly onSelectAll?: () => void
	// Alt with an arrow: move the selection by this many places.
	readonly onShift?: (delta: number) => void
	readonly onDelete?: () => void
	// A marquee selection: the items it touched; `additive` with Shift or Ctrl/Cmd held.
	readonly onMarquee?: (indices: readonly number[], additive: boolean) => void
	readonly announcement?: string
}

export const RAIL_ITEM_GAP = 12
// How far a mouse moves with its button down before a press becomes a drag (px).
const DRAG_START = 5
// The band at either end of the rail that scrolls it during a drag (px), and how far it scrolls per frame.
const EDGE = 32
const EDGE_STEP = 16
const LIVE_REGION: CSSProperties = {
	position: "absolute",
	width: 1,
	height: 1,
	overflow: "hidden",
	clipPath: "inset(50%)",
	whiteSpace: "nowrap"
}

export function railDevicePixelRatio(): number {
	const ratio: unknown = Reflect.get(globalThis, "devicePixelRatio")

	return typeof ratio === "number" && ratio > 0 ? Math.min(ratio, 3) : 1
}

export interface RailBitmap {
	readonly width: number
	readonly height: number
}

// A thumbnail drawn from a bitmap into a canvas sized to it; pending (empty) until the bitmap arrives.
export function PageRailThumb(props: {
	readonly bitmap: RailBitmap | undefined
	readonly width: number
	readonly height: number
	readonly classPrefix: string
}) {
	const { bitmap, width, height, classPrefix } = props
	const canvasRef = useRef<HTMLCanvasElement | null>(null)

	useLayoutEffect(() => {
		const canvas = canvasRef.current

		if (canvas === null || bitmap === undefined) return

		const context = canvas.getContext("2d")

		if (context === null) return

		// A size written again resets the canvas and its layout even when it is the same: only a new one is written.
		if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
			canvas.width = bitmap.width
			canvas.height = bitmap.height
		} else context.clearRect(0, 0, canvas.width, canvas.height)

		context.drawImage(bitmap as unknown as CanvasImageSource, 0, 0)
	}, [bitmap])

	return (
		<span
			className={`${classPrefix}-thumb`}
			data-fo-pending={bitmap === undefined ? "" : undefined}
			style={{ width, height }}
		>
			{bitmap === undefined ? null : (
				<canvas
					ref={canvasRef}
					className={`${classPrefix}-canvas`}
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

// A marquee in content coordinates (along / across the rail).
interface Marquee {
	readonly pointerId: number
	readonly along: number
	readonly across: number
	toAlong: number
	toAcross: number
	readonly additive: boolean
}

// The items whose cells a marquee touches.
function marqueeHits(rows: RailRows, marquee: Marquee, cell: number, crossSize: number, gap: number): number[] {
	const along0 = Math.min(marquee.along, marquee.toAlong)
	const along1 = Math.max(marquee.along, marquee.toAlong)
	const across0 = Math.min(marquee.across, marquee.toAcross)
	const across1 = Math.max(marquee.across, marquee.toAcross)
	const range = rowRange(rows, along0, along1 - along0, 0)
	const hits: number[] = []

	for (let row = range.first; row <= range.last; row++) {
		const first = rows.items[row] ?? -1
		const start = rows.starts[row] ?? 0
		const end = (rows.starts[row + 1] ?? start) - gap

		if (first < 0 || end < along0 || start > along1) continue

		const span = rows.counts[row] ?? 0

		for (let column = 0; column < span; column++) {
			const left = cell > 0 ? column * cell : 0
			const right = cell > 0 ? left + cell : crossSize

			if (right >= across0 && left <= across1) hits.push(first + column)
		}
	}

	return hits
}

export function PageRail({
	count,
	itemKey,
	aspect,
	current,
	onSelect,
	label,
	itemLabel,
	renderItem,
	onWindow,
	thumbsVersion,
	orientation,
	layout,
	thumbWidth: thumbWidthProp,
	cellChrome,
	gap: gapProp,
	overscan: overscanProp,
	className,
	classPrefix: classPrefixProp,
	focusMode,
	rows: rowsProp,
	headerExtent: headerExtentProp,
	renderHeader,
	itemAttributes,
	selected,
	onExtend,
	onMove,
	onCommandKey,
	onToggle,
	onSelectAll,
	onShift,
	onDelete,
	onMarquee,
	announcement
}: PageRailProps) {
	const prefix = classPrefixProp ?? "fo-page-rail"
	const vertical = orientation !== "horizontal"
	const roving = focusMode === "roving"
	const gap = Math.max(0, gapProp ?? RAIL_ITEM_GAP)
	const thumbWidth = Math.max(16, Math.round(thumbWidthProp ?? 160))
	const thumbHeight = Math.max(9, Math.round(thumbWidth * (aspect > 0 && Number.isFinite(aspect) ? aspect : 0.5625)))
	const extent = (vertical ? thumbHeight : thumbWidth) + gap
	const headerExtent = Math.max(0, headerExtentProp ?? 0)
	const overscan = Math.max(0, overscanProp ?? 3)
	const containerRef = useRef<HTMLDivElement | null>(null)
	const [viewport, setViewport] = useState({ offset: 0, size: 0, cross: 0 })
	const [drop, setDrop] = useState<number | undefined>(undefined)
	const [marquee, setMarquee] = useState<Marquee | undefined>(undefined)
	const press = useRef<Press | undefined>(undefined)
	// A drag just ended: the click its release fires selects nothing.
	const dragged = useRef(false)
	const edgeScroll = useRef<{ frame: number; speed: number }>({ frame: 0, speed: 0 })
	const ids = useId()
	const grid = layout === "grid" && vertical
	const cell = grid ? thumbWidth + Math.max(0, cellChrome ?? 0) + gap : 0
	const columns = grid && cell > 0 ? Math.max(1, Math.floor((viewport.cross + gap) / cell)) : 1
	const rows = rowsProp === undefined ? itemRows(count, extent, columns) : railRows(rowsProp, count, extent, headerExtent, columns)
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
			const cross = vertical ? container.clientWidth : container.clientHeight

			setViewport(previous =>
				previous.offset === offset && previous.size === size && previous.cross === cross ? previous : { offset, size, cross }
			)
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

	// The current item stays in view when it changes (keys, the page, a jump); with roving focus it takes the focus
	// when the rail has it.
	useLayoutEffect(() => {
		const container = containerRef.current

		if (container === null || count === 0 || currentRow < 0) return

		const offset = vertical ? container.scrollTop : container.scrollLeft
		const size = vertical ? container.clientHeight : container.clientWidth
		const target = revealRowOffset(rows, currentRow, offset, size)

		if (target !== undefined) {
			if (vertical) container.scrollTop = target
			else container.scrollLeft = target
		}

		if (!roving) return

		const active = container.ownerDocument.activeElement
		const option = container.ownerDocument.getElementById(`${ids}-item-${String(selectedIndex)}`)

		if (option !== null && active !== option && active !== null && container.contains(active)) option.focus({ preventScroll: true })
	}, [currentRow, selectedIndex, total, vertical, count, roving])

	// Thumbnails for what is mounted, at device pixels: the items in view first, then the overscan nearest first.
	useEffect(() => {
		if (onWindow === undefined || range.last < range.first) return

		const indices: number[] = []
		let inView = 0

		for (const row of thumbnailOrder(range, visible)) {
			const first = rows.items[row] ?? -1

			for (let column = 0; first >= 0 && column < (rows.counts[row] ?? 0); column++) indices.push(first + column)

			if (row >= visible.first && row <= visible.last) inView = indices.length
		}

		onWindow(indices, thumbWidth * railDevicePixelRatio(), inView)
	}, [range.first, range.last, visible.first, visible.last, count, columns, rowsProp, thumbsVersion, thumbWidth, onWindow])

	useEffect(
		() => () => {
			if (edgeScroll.current.frame !== 0) cancelAnimationFrame(edgeScroll.current.frame)
		},
		[]
	)

	const optionId = (index: number): string => `${ids}-item-${String(index)}`
	const isSelected = (index: number): boolean => index === selectedIndex || selected?.has(index) === true

	// A pointer's position along and across the rail's content.
	const contentPoint = (event: { readonly clientX: number; readonly clientY: number }): { along: number; across: number } => {
		const container = containerRef.current

		if (container === null) return { along: 0, across: 0 }

		const box = container.getBoundingClientRect()
		const x = event.clientX - box.left + container.scrollLeft
		const y = event.clientY - box.top + container.scrollTop

		return vertical ? { along: y, across: x } : { along: x, across: y }
	}

	const dropAt = (event: { readonly clientX: number; readonly clientY: number }): number => {
		const point = contentPoint(event)

		return dropBefore(rows, count, point.along, grid ? { position: point.across, cell } : undefined)
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
		setMarquee(undefined)
	}

	const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
		const container = containerRef.current

		if (onMarquee === undefined || container === null || event.button !== 0 || event.pointerType === "touch") return
		// Only from the background: a press on an item selects or drags it.
		if (event.target instanceof Element && event.target.closest("[role=option]") !== null) return

		const point = contentPoint(event)

		container.setPointerCapture(event.pointerId)
		setMarquee({
			pointerId: event.pointerId,
			along: point.along,
			across: point.across,
			toAlong: point.along,
			toAcross: point.across,
			additive: event.shiftKey || event.ctrlKey || event.metaKey
		})
	}

	const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
		if (marquee !== undefined && marquee.pointerId === event.pointerId) {
			const point = contentPoint(event)

			setMarquee({ ...marquee, toAlong: point.along, toAcross: point.across })
			updateEdgeScroll(event)

			return
		}

		const held = press.current

		if (held === undefined || held.pointerId !== event.pointerId || onMove === undefined) return

		if (!held.dragging) {
			if (Math.hypot(event.clientX - held.x, event.clientY - held.y) < DRAG_START) return

			held.dragging = true
			containerRef.current?.setPointerCapture(event.pointerId)

			// An item dragged from outside the selection is dragged alone.
			if (!isSelected(held.index)) onSelect(held.index)
		}

		const before = dropAt(event)

		setDrop(previous => (previous === before ? previous : before))
		updateEdgeScroll(event)
	}

	const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
		if (marquee !== undefined && marquee.pointerId === event.pointerId) {
			const point = contentPoint(event)
			const final = { ...marquee, toAlong: point.along, toAcross: point.across }
			const moved = Math.hypot(final.toAlong - final.along, final.toAcross - final.across) >= DRAG_START

			endPress()

			if (moved) onMarquee?.(marqueeHits(rows, final, cell, viewport.cross, gap), final.additive)

			return
		}

		const held = press.current

		if (held === undefined || held.pointerId !== event.pointerId) return

		if (held.dragging) {
			// The click this release makes (on the item or, with the pointer captured, on the list) is not a selection;
			// cleared after this task, so it never swallows the next real click.
			dragged.current = true
			setTimeout(() => {
				dragged.current = false
			}, 0)
			onMove?.(dropAt(event))
		}

		endPress()
	}

	const shiftDelta = (key: string): number => {
		if (grid) {
			if (key === "ArrowLeft") return -1
			if (key === "ArrowRight") return 1
			if (key === "ArrowUp") return -columns
			if (key === "ArrowDown") return columns

			return 0
		}

		if (key === (vertical ? "ArrowUp" : "ArrowLeft")) return -1
		if (key === (vertical ? "ArrowDown" : "ArrowRight")) return 1

		return 0
	}

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (event.key === "Escape" && (press.current?.dragging === true || marquee !== undefined)) {
			event.preventDefault()
			endPress()

			return
		}

		if (onCommandKey?.(event) === true) return

		const mod = event.ctrlKey || event.metaKey

		if (onSelectAll !== undefined && mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "a") {
			event.preventDefault()
			onSelectAll()

			return
		}

		if (onShift !== undefined && event.altKey && !mod) {
			const delta = shiftDelta(event.key)

			if (delta !== 0) {
				event.preventDefault()
				onShift(delta)

				return
			}
		}

		if (onDelete !== undefined && (event.key === "Delete" || event.key === "Backspace") && !mod && !event.altKey) {
			event.preventDefault()
			onDelete()

			return
		}

		if (event.key === " " && onToggle !== undefined && !mod && !event.altKey) {
			event.preventDefault()
			onToggle(selectedIndex)

			return
		}

		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault()
			onSelect(selectedIndex)

			return
		}

		const page = Math.max(1, Math.floor(viewport.size / extent))
		const target = railKeyTarget(event.key, selectedIndex, count, page, vertical, columns)

		if (target === undefined || event.altKey || event.ctrlKey || event.metaKey) return

		event.preventDefault()

		if (event.shiftKey && onExtend !== undefined) onExtend(target, "range")
		else if (target !== selectedIndex) onSelect(target)
	}

	const items: ReactNode[] = []
	const mountItem = (index: number, row: number, column: number): void => {
		const position = rows.starts[row] ?? 0
		const size = (rows.starts[row + 1] ?? position) - position
		const place: CSSProperties = vertical
			? grid
				? { top: position, height: size, left: column * cell, width: cell }
				: { top: position, height: size }
			: { left: position, width: size }

		items.push(
			<div
				key={itemKey(index)}
				id={optionId(index)}
				role="option"
				className={`${prefix}-item`}
				aria-selected={isSelected(index)}
				aria-current={index === selectedIndex ? "true" : undefined}
				aria-posinset={index + 1}
				aria-setsize={count}
				aria-label={itemLabel(index, count)}
				tabIndex={roving ? (index === selectedIndex ? 0 : -1) : undefined}
				data-fo-index={index}
				{...itemAttributes?.(index)}
				style={place}
				onPointerDown={event => {
					if (onMove !== undefined && event.button === 0 && event.pointerType !== "touch") {
						press.current = { pointerId: event.pointerId, index, x: event.clientX, y: event.clientY, dragging: false }
					}
				}}
				onClick={event => {
					if (dragged.current) {
						dragged.current = false

						return
					}

					if (onExtend !== undefined && event.shiftKey) onExtend(index, "range")
					else if (onExtend !== undefined && (event.ctrlKey || event.metaKey)) onExtend(index, "toggle")
					else onSelect(index)
				}}
			>
				{renderItem(index, { width: thumbWidth, height: thumbHeight })}
			</div>
		)
	}
	const mount = (row: number): void => {
		const item = rows.items[row]
		const position = rows.starts[row] ?? 0
		const size = (rows.starts[row + 1] ?? position) - position

		if (item === undefined) return

		if (item < 0) {
			items.push(
				<div
					key={`section-${String(-1 - item)}`}
					className={`${prefix}-section`}
					role="none"
					aria-hidden="true"
					data-fo-section={-1 - item}
					style={vertical ? { top: position, height: size } : { left: position, width: size }}
				>
					{renderHeader?.(-1 - item)}
				</div>
			)

			return
		}

		for (let column = 0; column < (rows.counts[row] ?? 0); column++) mountItem(item + column, row, column)
	}

	for (let row = range.first; row <= range.last; row++) mount(row)

	// The current item is always mounted, wherever the view is (the active descendant, the roving focus).
	if (count > 0 && currentRow >= 0 && (currentRow < range.first || currentRow > range.last)) {
		mountItem(selectedIndex, currentRow, selectedIndex - (rows.items[currentRow] ?? selectedIndex))
	}

	const marker = drop === undefined ? undefined : grid ? dropCell(rows, drop, cell) : { along: dropLineOffset(rows, drop), across: 0 }
	const box =
		marquee === undefined
			? undefined
			: {
					along: Math.min(marquee.along, marquee.toAlong),
					across: Math.min(marquee.across, marquee.toAcross),
					alongSize: Math.abs(marquee.toAlong - marquee.along),
					acrossSize: Math.abs(marquee.toAcross - marquee.across)
				}

	const listbox = (
		<div
			ref={containerRef}
			className={className === undefined ? prefix : `${prefix} ${className}`}
			data-fo-orientation={vertical ? "vertical" : "horizontal"}
			data-fo-layout={grid ? "grid" : undefined}
			data-fo-dragging={drop === undefined ? undefined : ""}
			role="listbox"
			aria-label={label}
			aria-orientation={vertical ? "vertical" : "horizontal"}
			aria-multiselectable={selected === undefined ? undefined : true}
			aria-activedescendant={roving || count === 0 ? undefined : optionId(selectedIndex)}
			tabIndex={roving && count > 0 ? -1 : 0}
			onKeyDown={onKeyDown}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={endPress}
		>
			<div
				className={`${prefix}-content`}
				role="none"
				style={vertical ? { height: total, width: "100%" } : { width: total, height: "100%" }}
			>
				{items}
				{marker === undefined ? null : (
					<div
						className={`${prefix}-drop`}
						aria-hidden="true"
						data-fo-axis={grid ? "across" : undefined}
						style={
							grid
								? { top: marker.along, left: Math.max(0, marker.across - gap / 2 - 1), height: extent - gap }
								: vertical
									? { top: Math.max(0, marker.along - 1) }
									: { left: Math.max(0, marker.along - 1) }
						}
					/>
				)}
				{box === undefined ? null : (
					<div
						className={`${prefix}-marquee`}
						aria-hidden="true"
						style={
							vertical
								? { top: box.along, left: box.across, height: box.alongSize, width: box.acrossSize }
								: { left: box.along, top: box.across, width: box.alongSize, height: box.acrossSize }
						}
					/>
				)}
			</div>
		</div>
	)

	// The live region sits beside the listbox, never in it (a listbox holds options only), and is always mounted, so an
	// announcement set later is read.
	return (
		<>
			{listbox}
			<div
				role="status"
				aria-live="polite"
				style={LIVE_REGION}
			>
				{announcement ?? ""}
			</div>
		</>
	)
}
