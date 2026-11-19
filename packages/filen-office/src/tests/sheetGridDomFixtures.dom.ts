import { act, createElement, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, vi } from "vitest"
import type { SheetCommand, SheetEvent, SheetFileKind, SheetSessionApi } from "../core/sheet/protocol"
import { inThreadSheetHost } from "../dom/sheet/host"
import { SheetGrid, SheetGridModel, type SheetGridHandle, type SheetGridProps } from "../react/sheet/index"
import { RecordingCanvas } from "./sheetGridCanvas"
import { IMMEDIATE } from "./sheetSessionFixtures"

// The grid component mounted in happy-dom on the in-thread host: recording canvases, a sized scroller, the roots
// unmounted after each test, and the events a test dispatches.

export const GRID_WIDTH = 800
export const GRID_HEIGHT = 400

const canvases = new WeakMap<HTMLCanvasElement, RecordingCanvas>()
const roots: Root[] = []

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

// Called at a test file's top level: restoreMocks undoes the stubs after every test, so they go on before each one.
export function registerSheetGridDom(): void {
	beforeEach(() => {
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
			let canvas = canvases.get(this)

			if (canvas === undefined) {
				canvas = new RecordingCanvas()
				canvases.set(this, canvas)
			}

			return canvas as unknown as CanvasRenderingContext2D
		} as unknown as typeof HTMLCanvasElement.prototype.getContext)
		vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
			return this.classList.contains("fo-sheet-scroller") ? GRID_WIDTH : 0
		})
		vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
			return this.classList.contains("fo-sheet-scroller") ? GRID_HEIGHT : 0
		})
		vi.spyOn(Element.prototype, "setPointerCapture").mockImplementation(() => undefined)
	})
	afterEach(unmountGrids)
}

// A root a test renders itself, unmounted with the others.
export function trackRoot(root: Root): Root {
	roots.push(root)

	return root
}

export function unmountGrids(): void {
	for (const root of roots.splice(0)) act(() => root.unmount())

	document.body.innerHTML = ""
}

// What was drawn on a canvas the grid rendered.
export function recorded(canvas: Element | null | undefined): RecordingCanvas {
	const recording = canvas instanceof HTMLCanvasElement ? canvases.get(canvas) : undefined

	if (recording === undefined) throw new Error("no recorded canvas")

	return recording
}

export async function settleGrid(): Promise<void> {
	for (let k = 0; k < 8; k++) await act(() => new Promise(resolve => setTimeout(resolve, 0)))
}

export interface OpenGridOptions {
	readonly bytes: Uint8Array
	readonly kind?: SheetFileKind
	// Hands the session's events from the open on to the model, as an app does; otherwise they are dropped.
	readonly forwardEvents?: boolean
}

export interface OpenedGrid {
	readonly model: SheetGridModel
	// What edits go through.
	readonly session: SheetSessionApi
}

export async function openGrid({ bytes, kind = "xlsx", forwardEvents = false }: OpenGridOptions): Promise<OpenedGrid> {
	const host = inThreadSheetHost()
	// Events before the model exists wait for it.
	const early: SheetEvent[] = []
	let target: SheetGridModel | null = null
	const opened = await host.open(bytes, { kind, slicing: IMMEDIATE }, event => {
		if (!forwardEvents) return

		if (target === null) early.push(event)
		else target.handleEvent(event)
	})

	if (opened.kind !== "opened") throw new Error(opened.kind)

	const model = new SheetGridModel({ source: opened.session, edit: opened.session, info: opened.info })

	target = model

	for (const event of early.splice(0)) model.handleEvent(event)

	return { model, session: opened.session }
}

export interface MountGridOptions extends OpenGridOptions {
	readonly props?: Partial<SheetGridProps>
	// Records every command the grid sends through the model.
	readonly recordCommands?: boolean
}

export interface MountedGrid extends OpenedGrid {
	readonly handle: SheetGridHandle
	readonly root: Root
	readonly container: HTMLElement
	readonly scroller: HTMLElement
	// The grid's own element (.fo-sheet).
	readonly sheet: HTMLElement
	// The cells canvas, and the chrome one over it: headers and the selection.
	readonly cells: RecordingCanvas
	readonly chrome: RecordingCanvas
	// Empty unless recordCommands was set.
	readonly commands: SheetCommand[]
	paint(): void
}

export async function mountGrid(options: MountGridOptions): Promise<MountedGrid> {
	const { model, session } = await openGrid(options)
	const commands: SheetCommand[] = []

	if (options.recordCommands === true) {
		const command = model.command.bind(model)

		vi.spyOn(model, "command").mockImplementation((sent, report) => {
			commands.push(sent)

			return command(sent, report)
		})
	}

	const container = document.createElement("div")
	const ref = createRef<SheetGridHandle>()
	const root = trackRoot(createRoot(container))

	document.body.appendChild(container)
	await act(async () => {
		root.render(createElement(SheetGrid, { ref, grid: model, label: "Sheet", editorLabel: "Cell entry", ...options.props }))
	})
	await settleGrid()

	const handle = ref.current as SheetGridHandle
	const paint = (): void => {
		act(() => handle.renderer.paint())
	}

	paint()
	await settleGrid()
	paint()

	const drawn = container.querySelectorAll("canvas")

	return {
		model,
		session,
		handle,
		root,
		container,
		scroller: container.querySelector<HTMLElement>(".fo-sheet-scroller") as HTMLElement,
		sheet: container.querySelector<HTMLElement>(".fo-sheet") as HTMLElement,
		cells: recorded(drawn[0]),
		chrome: recorded(drawn[1]),
		commands,
		paint
	}
}

export function key(target: Element, init: KeyboardEventInit & { keyCode?: number }): KeyboardEvent {
	const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })

	if (init.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: init.keyCode })

	act(() => {
		target.dispatchEvent(event)
	})

	return event
}

// A mouse's primary button unless init says otherwise.
export function pointer(target: Element, type: string, init: PointerEventInit): void {
	act(() => {
		target.dispatchEvent(
			new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0, ...init })
		)
	})
}
