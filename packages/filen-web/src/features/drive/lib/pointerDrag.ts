import { dragDropMode, type DragDropMode } from "@/features/drive/lib/dnd.logic"
import {
	AUTO_SCROLL_EDGE_PX,
	AUTO_SCROLL_MAX_SPEED_PX,
	marqueeAutoScrollTop,
	marqueeAutoScrollVelocity
} from "@/features/drive/lib/marquee.logic"
import { outsideWindow, passedThreshold, pickDropTarget, type Point } from "@/features/drive/lib/pointerDrag.logic"
import type { DriveItem } from "@/features/drive/lib/item"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"

// The one drag engine for drive items (rows, tiles, tree nodes), on pointer events rather than HTML5 drag
// and drop: a running HTML5 drag can never become an OS drag carrying our files, this one can be handed
// off when it leaves the window (setPointerDragHooks). OS file drags into the page stay HTML5
// (uploadDropzone.tsx, useDriveDropTarget's acceptFiles).
//
// One drag at a time, held at module level. A press listens on the window for its pointer; past the
// threshold the drag listens for keys and focus too, all in the capture phase and owned here, never by
// the source element: a virtualized row scrolled away or a spring-loaded navigation unmounts the source
// mid-drag, so nothing ends on lostpointercapture. Idle, nothing listens and nothing is timed.

const MAC = isMacPlatform()

// Set on every registered drop target, so the hit-test walks only to them.
export const DROP_TARGET_ATTRIBUTE = "data-filen-drop"
// Set on a scroll container that scrolls when a drag rests near its top or bottom edge.
export const DRAG_SCROLL_ATTRIBUTE = "data-filen-drag-scroll"

// The chip follows the pointer at the same point HTML5 held its drag image by.
const CHIP_ANCHOR = { x: 14, y: 15 }

// What a drop target is told after a hit-test, only when it changes: `over` while it would take the drop
// (its highlight), `spring` while the drag rests on it as the target to spring open. null once the drag
// has left it or ended.
export interface DropTargetState {
	over: boolean
	mode: DragDropMode
	spring: boolean
}

export interface DropTargetHandlers {
	// Takes the current payload in this mode.
	accepts: (mode: DragDropMode) => boolean
	// Would spring open under the current payload.
	springs: () => boolean
	update: (state: DropTargetState | null, element: HTMLElement) => void
	drop: (mode: DragDropMode) => void
}

// What a drag source gives the engine: the items, resolved once the press becomes a drag (undefined
// cancels it), the chip drawn for them, and the end of the drag, however it ends.
export interface PointerDragSource {
	start: () => readonly DriveItem[] | undefined
	chip: (items: readonly DriveItem[]) => HTMLCanvasElement | null
	end: () => void
}

export interface PointerDragHooks {
	onStart?(items: readonly DriveItem[]): void
	// "handedOff": the page let the OS take the drag (returned as soon as begin was issued); the engine
	// stops hit-testing and hides the chip; resumePointerDrag() brings it back.
	onMove?(p: Point, outside: boolean, buttons: number): "continue" | "handedOff"
	onEnd?(dropped: boolean): void
}

// The press fields the engine reads (a React or a DOM pointer event).
export interface PointerDragPress {
	pointerId: number
	pointerType: string
	button: number
	isPrimary: boolean
	clientX: number
	clientY: number
	altKey: boolean
	ctrlKey: boolean
}

interface Session {
	pointerId: number
	source: PointerDragSource
	origin: Point
	last: Point
	altKey: boolean
	ctrlKey: boolean
	phase: "pressed" | "dragging" | "handedOff"
	chip: HTMLCanvasElement | null
	states: Map<HTMLElement, DropTargetState>
	drop: HTMLElement | null
	mode: DragDropMode
	cursor: string
	frame: number
	detach: (() => void)[]
}

const targets = new WeakMap<HTMLElement, DropTargetHandlers>()
let hooks: PointerDragHooks | null = null
let session: Session | null = null

// X9 installs the desktop hand-off; null removes it.
export function setPointerDragHooks(next: PointerDragHooks | null): void {
	hooks = next
}

// Registers `element` as a drop target until the returned unregister runs. A target appearing or going
// under a drag (a spring-loaded listing mounting) is hit-tested on the next frame without a move.
export function registerDropTarget(element: HTMLElement, handlers: DropTargetHandlers): () => void {
	targets.set(element, handlers)
	element.setAttribute(DROP_TARGET_ATTRIBUTE, "")
	scheduleFrame()

	return () => {
		if (targets.get(element) === handlers) {
			targets.delete(element)
			element.removeAttribute(DROP_TARGET_ATTRIBUTE)
		}

		scheduleFrame()
	}
}

// The chip of the drag under way, for a hand-off that shows it as the OS drag image.
export function pointerDragChip(): HTMLCanvasElement | null {
	return session?.chip ?? null
}

// A late refusal of a hand-off: back to the in-app drag, if the drag is still held.
export function resumePointerDrag(): void {
	if (session?.phase !== "handedOff") {
		return
	}

	session.phase = "dragging"

	if (session.chip !== null) {
		session.chip.style.display = ""
	}

	scheduleFrame()
}

// Ends the drag under way without a drop (a refused or finished hand-off).
export function cancelPointerDrag(): void {
	end(false)
}

// A press on a drag source. Primary mouse or pen button only: touch keeps its long-press selection
// (useTouchLongPress) and scrolls.
export function pressPointerDrag(event: PointerDragPress, source: PointerDragSource): void {
	if ((event.pointerType !== "mouse" && event.pointerType !== "pen") || event.button !== 0 || !event.isPrimary) {
		return
	}

	end(false)

	const point = { x: event.clientX, y: event.clientY }

	session = {
		pointerId: event.pointerId,
		source,
		origin: point,
		last: point,
		altKey: event.altKey,
		ctrlKey: event.ctrlKey,
		phase: "pressed",
		chip: null,
		states: new Map(),
		drop: null,
		mode: "move",
		cursor: "",
		frame: 0,
		detach: []
	}

	listen("pointermove", onPointerMove)
	listen("pointerup", onPointerUp)
	listen("pointercancel", onPointerCancel)
	// A press that opens a context menu (macOS Ctrl+click is a primary press) is not a drag.
	listen("contextmenu", onContextMenu)
}

function listen<K extends keyof WindowEventMap>(type: K, listener: (event: WindowEventMap[K]) => void): void {
	window.addEventListener(type, listener, true)
	session?.detach.push(() => {
		window.removeEventListener(type, listener, true)
	})
}

function ownPointer(event: PointerEvent): boolean {
	return session !== null && event.pointerId === session.pointerId
}

function onContextMenu(): void {
	if (session?.phase === "pressed") {
		end(false)
	}
}

function onPointerCancel(event: PointerEvent): void {
	if (ownPointer(event)) {
		end(false)
	}
}

function onPointerMove(event: PointerEvent): void {
	const current = session

	if (current === null || !ownPointer(event)) {
		return
	}

	// No pointerup reaches the page after an OS drag, or after a release it never saw.
	if (event.buttons === 0) {
		end(false)

		return
	}

	current.last = { x: event.clientX, y: event.clientY }

	if (current.phase === "pressed") {
		if (!passedThreshold(current.origin, current.last)) {
			return
		}

		begin(current)

		if (session !== current) {
			return
		}
	}

	if (current.phase === "handedOff") {
		return
	}

	setModifiers(current, event)

	if (
		hooks?.onMove?.(
			current.last,
			outsideWindow(current.last, { width: window.innerWidth, height: window.innerHeight }),
			event.buttons
		) === "handedOff"
	) {
		handOff(current)

		return
	}

	scheduleFrame()
}

function begin(current: Session): void {
	const items = current.source.start()

	// Nothing to drag: the press ends as it began, with no end to tell the source.
	if (items === undefined) {
		end(false)

		return
	}

	current.phase = "dragging"
	current.chip = current.source.chip(items)

	if (current.chip !== null) {
		const style = current.chip.style

		style.position = "fixed"
		style.top = "0"
		style.left = "0"
		style.zIndex = "2147483647"
		style.pointerEvents = "none"
		style.willChange = "transform"
		document.body.appendChild(current.chip)
	}

	document.body.classList.add("pointer-drag")
	// A press on text may already have started selecting it.
	window.getSelection()?.removeAllRanges()
	listen("keydown", onKey)
	listen("keyup", onKey)
	listen("blur", onBlur)
	hooks?.onStart?.(items)
}

function setModifiers(current: Session, event: { altKey: boolean; ctrlKey: boolean }): boolean {
	if (current.altKey === event.altKey && current.ctrlKey === event.ctrlKey) {
		return false
	}

	current.altKey = event.altKey
	current.ctrlKey = event.ctrlKey

	return true
}

function onKey(event: KeyboardEvent): void {
	const current = session

	if (current === null) {
		return
	}

	if (event.type === "keydown" && event.key === "Escape") {
		event.preventDefault()
		event.stopPropagation()
		end(false)

		return
	}

	// The copy modifier switches the mode under a resting pointer.
	if (setModifiers(current, event)) {
		scheduleFrame()
	}
}

// The window's own blur, not an element's (a capture listener on the window hears those too).
function onBlur(event: FocusEvent): void {
	if (!(event.target instanceof Node)) {
		end(false)
	}
}

function onPointerUp(event: PointerEvent): void {
	const current = session

	if (current === null || !ownPointer(event)) {
		return
	}

	if (current.phase !== "dragging") {
		end(false)

		return
	}

	current.last = { x: event.clientX, y: event.clientY }
	setModifiers(current, event)
	hitTest(current)

	const drop = current.drop
	const handlers = drop === null ? undefined : targets.get(drop)

	handlers?.drop(current.mode)
	end(handlers !== undefined)
}

function handOff(current: Session): void {
	current.phase = "handedOff"
	cancelFrame(current)
	clearStates(current)
	setCursor(current, "")

	if (current.chip !== null) {
		current.chip.style.display = "none"
	}
}

function scheduleFrame(): void {
	if (session?.phase === "dragging" && session.frame === 0) {
		session.frame = requestAnimationFrame(onFrame)
	}
}

function cancelFrame(current: Session): void {
	if (current.frame !== 0) {
		cancelAnimationFrame(current.frame)
		current.frame = 0
	}
}

function onFrame(): void {
	const current = session

	if (current === null) {
		return
	}

	current.frame = 0

	if (current.phase !== "dragging") {
		return
	}

	if (current.chip !== null) {
		current.chip.style.transform = `translate(${String(current.last.x - CHIP_ANCHOR.x)}px, ${String(current.last.y - CHIP_ANCHOR.y)}px)`
	}

	const hit = hitTest(current)

	if (autoScroll(current, hit)) {
		scheduleFrame()
	}
}

// The registered targets from the hit element outward.
function targetChain(hit: Element | null): HTMLElement[] {
	const chain: HTMLElement[] = []
	let element = hit?.closest<HTMLElement>(`[${DROP_TARGET_ATTRIBUTE}]`) ?? null

	while (element !== null) {
		if (targets.has(element)) {
			chain.push(element)
		}

		element = element.parentElement?.closest<HTMLElement>(`[${DROP_TARGET_ATTRIBUTE}]`) ?? null
	}

	return chain
}

function sameState(a: DropTargetState | undefined, b: DropTargetState | undefined): boolean {
	return a?.over === b?.over && a?.mode === b?.mode && a?.spring === b?.spring
}

// One elementFromPoint per call. The drop goes to the nearest target taking the payload; the drag springs
// the nearest target that can, up to that one (a refusing row inside the listing still springs).
function hitTest(current: Session): Element | null {
	const hit = document.elementFromPoint(current.last.x, current.last.y)
	const chain = targetChain(hit)
	const mode = dragDropMode(current, MAC)
	const drop = pickDropTarget(chain, element => targets.get(element)?.accepts(mode) === true)
	const reach = drop === null ? chain : chain.slice(0, chain.indexOf(drop) + 1)
	const spring = reach.find(element => targets.get(element)?.springs() === true) ?? null
	const next = new Map<HTMLElement, DropTargetState>()

	if (drop !== null) {
		next.set(drop, { over: true, mode, spring: drop === spring })
	}

	if (spring !== null && spring !== drop) {
		next.set(spring, { over: false, mode, spring: true })
	}

	for (const [element] of current.states) {
		if (!next.has(element)) {
			targets.get(element)?.update(null, element)
		}
	}

	for (const [element, state] of next) {
		if (!sameState(current.states.get(element), state)) {
			targets.get(element)?.update(state, element)
		}
	}

	current.states = next
	current.drop = drop
	current.mode = mode
	setCursor(current, drop === null ? "pointer-drag-none" : mode === "copy" ? "pointer-drag-copy" : "")

	return hit
}

// Scrolls the container under the pointer one frame when it rests near an edge; true while it moved.
function autoScroll(current: Session, hit: Element | null): boolean {
	const scroller = hit?.closest<HTMLElement>(`[${DRAG_SCROLL_ATTRIBUTE}]`) ?? null

	if (scroller === null) {
		return false
	}

	const bounds = scroller.getBoundingClientRect()
	const velocity = marqueeAutoScrollVelocity(current.last.y, bounds.top, bounds.height, AUTO_SCROLL_EDGE_PX, AUTO_SCROLL_MAX_SPEED_PX)

	if (velocity === 0) {
		return false
	}

	const top = marqueeAutoScrollTop(scroller.scrollTop, velocity, scroller.scrollHeight, scroller.clientHeight)

	if (top === scroller.scrollTop) {
		return false
	}

	scroller.scrollTop = top

	return true
}

function setCursor(current: Session, cursor: string): void {
	if (current.cursor === cursor) {
		return
	}

	if (current.cursor !== "") {
		document.body.classList.remove(current.cursor)
	}

	if (cursor !== "") {
		document.body.classList.add(cursor)
	}

	current.cursor = cursor
}

function clearStates(current: Session): void {
	for (const [element] of current.states) {
		targets.get(element)?.update(null, element)
	}

	current.states = new Map()
	current.drop = null
}

// The click a released drag still produces lands on whatever lay under the pointer (a row it would select).
// Swallowed once, in the same turn; the listener is gone by the next.
function swallowNextClick(): void {
	function swallow(event: MouseEvent): void {
		event.preventDefault()
		event.stopPropagation()
		window.removeEventListener("click", swallow, true)
	}

	window.addEventListener("click", swallow, true)
	setTimeout(() => {
		window.removeEventListener("click", swallow, true)
	}, 0)
}

function end(dropped: boolean): void {
	const current = session

	if (current === null) {
		return
	}

	session = null

	for (const detach of current.detach) {
		detach()
	}

	if (current.phase === "pressed") {
		return
	}

	cancelFrame(current)
	clearStates(current)
	setCursor(current, "")
	current.chip?.remove()
	document.body.classList.remove("pointer-drag")
	current.source.end()
	swallowNextClick()
	hooks?.onEnd?.(dropped)
}
