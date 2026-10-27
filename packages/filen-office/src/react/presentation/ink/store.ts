import type { SlideRef } from "../../../core/presentation/model"
import type { InkOp, InkStroke } from "../../../core/presentation/edit/ops"

// The ink of a running slideshow: pen and highlighter strokes per slide, the eraser and the laser pointer. One store
// serves every window the show draws in (the audience stage and the presenter view), so a stroke drawn in either
// appears in both from the same pointer event. Points are slide EMU in growable Float64Arrays: a stroke never holds
// an object per point.

export type InkTool = "none" | "pen" | "highlighter" | "laser" | "eraser"

export interface InkStrokeBuffer {
	// x, y pairs in slide EMU; only the first `length` values are points.
	points: Float64Array
	length: number
	// EMU.
	readonly width: number
	// Six hex digits.
	readonly color: string
	readonly highlighter: boolean
}

export type InkChange =
	// Points appended to `stroke` from the value index `from` (a layer draws on from the point before it).
	| { readonly kind: "extend"; readonly slide: SlideRef; readonly stroke: InkStrokeBuffer; readonly from: number }
	// The slide's strokes changed other than by growing (erased, cleared): draw them all again.
	| { readonly kind: "redraw"; readonly slide: SlideRef }
	| { readonly kind: "laser"; readonly slide: SlideRef; readonly x: number; readonly y: number; readonly visible: boolean }

export interface InkState {
	readonly tool: InkTool
	readonly color: string
	// Some slide has ink.
	readonly inked: boolean
}

export interface InkStore {
	// Tool, colour and inked changes (React's useSyncExternalStore, which takes these unbound).
	readonly getSnapshot: () => InkState
	readonly subscribe: (listener: () => void) => () => void
	// Strokes and the laser, for the layers that draw them; called synchronously from the pointer event.
	listen(listener: (change: InkChange) => void): () => void
	setTool(tool: InkTool): void
	setColor(color: string): void
	strokes(slide: SlideRef): readonly InkStrokeBuffer[]
	// A pen or highlighter stroke (by the tool) starting at a point; ignored under any other tool.
	begin(slide: SlideRef, x: number, y: number): void
	// Points (x, y pairs) appended to the stroke begun last.
	extend(xy: readonly number[]): void
	end(): void
	// Removes the topmost stroke within `tolerance` EMU of the point; whether one was.
	eraseAt(slide: SlideRef, x: number, y: number, tolerance: number): boolean
	clear(slide: SlideRef): void
	laser(slide: SlideRef, x: number, y: number, visible: boolean): void
	// The ink as ops, one per slide with strokes, its group named `name`.
	ops(name: string): InkOp[]
	reset(): void
}

// PowerPoint's defaults: a red pen of 2.25 pt, a yellow highlighter of 9 pt.
export const INK_PEN_COLOR = "FF0000"
export const INK_HIGHLIGHTER_COLOR = "FFFF00"
export const INK_PEN_WIDTH = 28_575
export const INK_HIGHLIGHTER_WIDTH = 114_300
export const INK_COLORS: readonly string[] = ["FF0000", "0070C0", "00B050", "FFFF00", "000000", "FFFFFF"]

const INITIAL_POINTS = 64

// The distance from (x, y) to the segment (ax, ay)–(bx, by), squared.
function segmentDistance2(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax
	const dy = by - ay
	const length2 = dx * dx + dy * dy
	const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length2))
	const px = ax + t * dx - x
	const py = ay + t * dy - y

	return px * px + py * py
}

export function strokeHit(stroke: InkStrokeBuffer, x: number, y: number, tolerance: number): boolean {
	const reach = tolerance + stroke.width / 2
	const reach2 = reach * reach
	const points = stroke.points

	if (stroke.length === 2) return segmentDistance2(x, y, points[0] ?? 0, points[1] ?? 0, points[0] ?? 0, points[1] ?? 0) <= reach2

	for (let index = 2; index < stroke.length; index += 2) {
		if (segmentDistance2(x, y, points[index - 2] ?? 0, points[index - 1] ?? 0, points[index] ?? 0, points[index + 1] ?? 0) <= reach2)
			return true
	}

	return false
}

export function createInkStore(): InkStore {
	const slides = new Map<SlideRef, InkStrokeBuffer[]>()
	const listeners = new Set<() => void>()
	const changeListeners = new Set<(change: InkChange) => void>()
	let state: InkState = { tool: "none", color: INK_PEN_COLOR, inked: false }
	let current: { slide: SlideRef; stroke: InkStrokeBuffer } | undefined
	// The pen's colour, kept while the highlighter (which starts yellow) is picked.
	let penColor = INK_PEN_COLOR

	const set = (next: Partial<InkState>): void => {
		const merged = { ...state, ...next }

		if (merged.tool === state.tool && merged.color === state.color && merged.inked === state.inked) return

		state = merged

		for (const listener of listeners) listener()
	}

	const emit = (change: InkChange): void => {
		for (const listener of changeListeners) listener(change)
	}

	const anyInk = (): boolean => {
		for (const strokes of slides.values()) if (strokes.length > 0) return true

		return false
	}

	const append = (stroke: InkStrokeBuffer, xy: readonly number[]): void => {
		const needed = stroke.length + xy.length

		if (needed > stroke.points.length) {
			const grown = new Float64Array(Math.max(needed, stroke.points.length * 2))

			grown.set(stroke.points.subarray(0, stroke.length))
			stroke.points = grown
		}

		for (let index = 0; index < xy.length; index++) stroke.points[stroke.length + index] = xy[index] ?? 0

		stroke.length = needed
	}

	return {
		getSnapshot: () => state,
		subscribe: listener => {
			listeners.add(listener)

			return () => listeners.delete(listener)
		},
		listen: listener => {
			changeListeners.add(listener)

			return () => changeListeners.delete(listener)
		},
		setTool: tool => {
			current = undefined

			if (tool === "highlighter" && state.tool !== "highlighter") set({ tool, color: INK_HIGHLIGHTER_COLOR })
			else if (tool === "pen" && state.tool === "highlighter") set({ tool, color: penColor })
			else set({ tool })
		},
		setColor: color => {
			if (state.tool !== "highlighter") penColor = color

			set({ color })
		},
		strokes: slide => slides.get(slide) ?? [],
		begin: (slide, x, y) => {
			if (state.tool !== "pen" && state.tool !== "highlighter") return

			const highlighter = state.tool === "highlighter"
			const stroke: InkStrokeBuffer = {
				points: new Float64Array(INITIAL_POINTS),
				length: 0,
				width: highlighter ? INK_HIGHLIGHTER_WIDTH : INK_PEN_WIDTH,
				color: state.color,
				highlighter
			}
			let list = slides.get(slide)

			if (list === undefined) {
				list = []
				slides.set(slide, list)
			}

			append(stroke, [x, y])
			list.push(stroke)
			current = { slide, stroke }
			emit({ kind: "extend", slide, stroke, from: 0 })
			set({ inked: true })
		},
		extend: xy => {
			if (current === undefined || xy.length < 2) return

			const from = current.stroke.length

			append(current.stroke, xy.length % 2 === 0 ? xy : xy.slice(0, xy.length - 1))
			emit({ kind: "extend", slide: current.slide, stroke: current.stroke, from })
		},
		end: () => {
			current = undefined
		},
		eraseAt: (slide, x, y, tolerance) => {
			const list = slides.get(slide)

			if (list === undefined) return false

			for (let index = list.length - 1; index >= 0; index--) {
				const stroke = list[index]

				if (stroke !== undefined && strokeHit(stroke, x, y, tolerance)) {
					list.splice(index, 1)
					emit({ kind: "redraw", slide })
					set({ inked: anyInk() })

					return true
				}
			}

			return false
		},
		clear: slide => {
			const list = slides.get(slide)

			if (list === undefined || list.length === 0) return

			slides.delete(slide)

			if (current?.slide === slide) current = undefined

			emit({ kind: "redraw", slide })
			set({ inked: anyInk() })
		},
		laser: (slide, x, y, visible) => emit({ kind: "laser", slide, x, y, visible }),
		ops: name => {
			const out: InkOp[] = []

			for (const [slide, list] of slides) {
				if (list.length === 0) continue

				const strokes: InkStroke[] = list.map(stroke => ({
					points: stroke.points.slice(0, stroke.length),
					width: stroke.width,
					color: { kind: "srgb", rgb: stroke.color },
					highlighter: stroke.highlighter
				}))

				out.push({ family: "ink", kind: "add", slide, strokes, name })
			}

			return out
		},
		reset: () => {
			const inked = [...slides.keys()]

			slides.clear()
			current = undefined

			for (const slide of inked) emit({ kind: "redraw", slide })

			set({ tool: "none", color: INK_PEN_COLOR, inked: false })
			penColor = INK_PEN_COLOR
		}
	}
}
