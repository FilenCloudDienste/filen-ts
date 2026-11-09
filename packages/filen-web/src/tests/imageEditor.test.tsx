// @vitest-environment jsdom

import { createRef } from "react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@/lib/i18n"
import type {
	EditCapabilities,
	EditSession,
	ImageEditorCommands,
	ImageEditRecipe,
	ImageExportSource,
	SourceInfo
} from "@/features/preview/imageEdit/types"
import { ImageEditor } from "@/features/preview/imageEdit/components/imageEditor"
import { exportJpegQuality } from "@/features/preview/imageEdit/components/editorSession"
import { FILTER_PRESETS } from "@/features/preview/imageEdit/lib/filters"
import { PREVIEW_ACTIONS } from "@/features/preview/lib/keymap"
import { registerAction } from "@/lib/keymap/registry"

// The image editor over a fake render session: the canvas is handed over once per mount, the source loads once,
// every edit renders, sliders and nudges coalesce into one undo step, Mod+Z/Mod+Shift+Z undo and redo, the save
// export takes the lossless path only for a turned JPEG saved in place, filter thumbnails follow the geometry only,
// and a lock stops everything.

const resizeCallbacks: ResizeObserverCallback[] = []

class FakeResizeObserver {
	constructor(callback: ResizeObserverCallback) {
		resizeCallbacks.push(callback)
	}

	observe = vi.fn()
	unobserve = vi.fn()
	disconnect = vi.fn()
}

function resizeStage(width: number, height: number): void {
	act(() => {
		for (const callback of resizeCallbacks) {
			callback([{ contentRect: { width, height } } as ResizeObserverEntry], {} as ResizeObserver)
		}
	})
}

interface FakeBitmap {
	width: number
	height: number
	close: ReturnType<typeof vi.fn>
}

function fakeBitmap(): FakeBitmap {
	return { width: 96, height: 96, close: vi.fn() }
}

function fakeSession() {
	return {
		attach: vi.fn((_canvas: OffscreenCanvas, _width: number, _height: number, _ratio: number) => Promise.resolve()),
		resize: vi.fn(),
		load: vi.fn(() => Promise.resolve({ width: 400, height: 300 })),
		render: vi.fn((_recipe: ImageEditRecipe, _options: { compare: boolean }) => undefined),
		filterThumbnails: vi.fn(() => Promise.resolve([null, ...FILTER_PRESETS].map(() => fakeBitmap() as unknown as ImageBitmap))),
		export: vi.fn(() => Promise.resolve(new Blob(["x"], { type: "image/jpeg" }))),
		close: vi.fn()
	} satisfies EditSession
}

const INFO: SourceInfo = {
	mime: "image/jpeg",
	width: 400,
	height: 300,
	orientation: 1,
	hasAlpha: false,
	animated: false,
	pngTruecolor8: false,
	webpLossless: false,
	jpegQuality: 98,
	icc: null,
	exif: null,
	needsTail: false
}

const CAPABILITIES: EditCapabilities = { webgl2: true, maxTextureSize: 4096, maxPixels: 50_000_000, canEncodeWebp: true }

function mount(options: { locked?: boolean; info?: SourceInfo } = {}) {
	const session = fakeSession()
	const saveRef = createRef<ImageExportSource | null>()
	const commandsRef = createRef<ImageEditorCommands | null>()
	const onDirtyChange = vi.fn()
	const source = { kind: "blob" as const, blob: new Blob(["jpeg"]) }
	const info = options.info ?? INFO
	const view = render(
		<ImageEditor
			source={source}
			info={info}
			session={session}
			capabilities={CAPABILITIES}
			locked={options.locked ?? false}
			onDirtyChange={onDirtyChange}
			saveRef={saveRef}
			commandsRef={commandsRef}
		/>
	)

	return { session, saveRef, commandsRef, onDirtyChange, source, view }
}

function lastRendered(session: ReturnType<typeof fakeSession>): ImageEditRecipe {
	const call = session.render.mock.calls.at(-1)

	if (call === undefined) {
		throw new Error("nothing rendered")
	}

	return call[0]
}

// The thumb stays visibility:hidden until measured, which jsdom never does, and its name is then not computed: the
// slider is found through its label.
function slider(name: string): HTMLElement {
	const label = screen.getByText(name, { selector: "span" })
	const input = document.querySelector<HTMLElement>(`input[aria-labelledby="${label.id}"]`)

	if (input === null) {
		throw new Error(`no slider labelled ${name}`)
	}

	return input
}

beforeAll(() => {
	for (const def of PREVIEW_ACTIONS) {
		registerAction(def)
	}
})

beforeEach(() => {
	resizeCallbacks.length = 0
	vi.stubGlobal("ResizeObserver", FakeResizeObserver)
	HTMLCanvasElement.prototype.transferControlToOffscreen = vi.fn(() => ({}) as OffscreenCanvas)
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null)
	Element.prototype.setPointerCapture = vi.fn()
	Element.prototype.releasePointerCapture = vi.fn()
	Element.prototype.hasPointerCapture = vi.fn(() => true)
})

afterEach(() => {
	vi.useRealTimers()
})

describe("ImageEditor", () => {
	it("hands its canvas to the session, loads the source once and draws", async () => {
		const { session, source } = mount()

		await waitFor(() => {
			expect(session.render).toHaveBeenCalled()
		})

		expect(session.attach).toHaveBeenCalledTimes(1)
		expect(session.load).toHaveBeenCalledTimes(1)
		expect(session.load).toHaveBeenCalledWith(source, INFO)
		expect(lastRendered(session).geometry.crop).toEqual({ x: 0, y: 0, width: 1, height: 1 })

		resizeStage(640, 480)

		expect(session.resize).toHaveBeenLastCalledWith(640, 480, window.devicePixelRatio)
	})

	it("marks the root as a preview surface", () => {
		const { view } = mount()

		expect(view.container.querySelector("[data-preview-surface]")).not.toBeNull()
	})

	it("coalesces a slider run into one undo step, reports dirty, and undoes and redoes", async () => {
		const { session, onDirtyChange } = mount()

		await waitFor(() => {
			expect(session.render).toHaveBeenCalled()
		})

		const exposure = slider("Exposure")

		act(() => {
			exposure.focus()
		})
		fireEvent.keyDown(exposure, { key: "ArrowRight" })
		fireEvent.keyDown(exposure, { key: "ArrowRight" })
		fireEvent.keyDown(exposure, { key: "ArrowRight" })

		expect(lastRendered(session).adjustments.exposure).toBe(3)
		expect(onDirtyChange).toHaveBeenLastCalledWith(true)

		fireEvent.click(screen.getByRole("button", { name: "Undo" }))

		expect(lastRendered(session).adjustments.exposure).toBe(0)
		expect(onDirtyChange).toHaveBeenLastCalledWith(false)
		expect(screen.getByRole("button", { name: "Undo" })).toHaveProperty("disabled", true)

		fireEvent.click(screen.getByRole("button", { name: "Redo" }))

		expect(lastRendered(session).adjustments.exposure).toBe(3)
	})

	it("undoes on Mod+Z and redoes on Mod+Shift+Z, taking the keys from the overlay", async () => {
		const { session, view } = mount()

		await waitFor(() => {
			expect(session.render).toHaveBeenCalled()
		})

		fireEvent.click(screen.getByRole("tab", { name: "Crop" }))
		fireEvent.click(screen.getByRole("button", { name: "Rotate left" }))

		expect(lastRendered(session).geometry.quarterTurns).toBe(3)

		const root = view.container.querySelector("[data-preview-surface]")

		if (root === null) {
			throw new Error("no root")
		}

		const mac = navigator.platform.toLowerCase().includes("mac")

		// One of the two modifiers is the platform's Mod; the other must be absent.
		const undoEvent = new KeyboardEvent("keydown", { key: "z", ctrlKey: !mac, metaKey: mac, bubbles: true, cancelable: true })

		act(() => {
			root.dispatchEvent(undoEvent)
		})

		expect(undoEvent.defaultPrevented).toBe(true)
		expect(lastRendered(session).geometry.quarterTurns).toBe(0)

		const redoEvent = new KeyboardEvent("keydown", {
			key: "Z",
			shiftKey: true,
			ctrlKey: !mac,
			metaKey: mac,
			bubbles: true,
			cancelable: true
		})

		act(() => {
			root.dispatchEvent(redoEvent)
		})

		expect(redoEvent.defaultPrevented).toBe(true)
		expect(lastRendered(session).geometry.quarterTurns).toBe(3)
	})

	it("saves a turned JPEG in place as an Orientation rewrite, and re-encodes for a copy", async () => {
		const { session, saveRef } = mount()

		await waitFor(() => {
			expect(session.render).toHaveBeenCalled()
		})

		fireEvent.click(screen.getByRole("tab", { name: "Crop" }))
		fireEvent.click(screen.getByRole("button", { name: "Rotate left" }))

		const save = saveRef.current

		if (save === null) {
			throw new Error("no save source")
		}

		await expect(save({ kind: "inPlace", mime: "image/jpeg" })).resolves.toEqual({ blob: null, geometryOnly: { orientation: 8 } })
		expect(session.export).not.toHaveBeenCalled()

		const copy = await save({ kind: "copy", mime: "image/jpeg", extension: "jpg" })

		expect(copy.geometryOnly).toBeNull()
		expect(copy.blob).toBeInstanceOf(Blob)
		expect(session.export).toHaveBeenCalledWith(
			expect.objectContaining({ geometry: expect.objectContaining({ quarterTurns: 3 }) as unknown }),
			{ mime: "image/jpeg", quality: 0.92 },
			{ exif: null, icc: null, hasAlpha: false, webpLossless: false }
		)
	})

	it("re-encodes in place once the pixels change", async () => {
		const { session, saveRef } = mount()

		await waitFor(() => {
			expect(session.render).toHaveBeenCalled()
		})

		fireEvent.click(screen.getByRole("tab", { name: "Filters" }))
		fireEvent.click(screen.getByRole("button", { name: "Mono" }))

		const result = await saveRef.current?.({ kind: "inPlace", mime: "image/jpeg" })

		expect(result?.geometryOnly).toBeNull()
		expect(session.export).toHaveBeenCalledTimes(1)
	})

	it("keeps the JPEG quality within 75..92", () => {
		expect(exportJpegQuality({ ...INFO, jpegQuality: 98 })).toBe(0.92)
		expect(exportJpegQuality({ ...INFO, jpegQuality: 50 })).toBe(0.75)
		expect(exportJpegQuality({ ...INFO, jpegQuality: 85 })).toBe(0.85)
		expect(exportJpegQuality({ ...INFO, jpegQuality: null })).toBe(0.92)
	})

	it("asks for filter thumbnails once per geometry and closes the ones it replaces", async () => {
		const { session } = mount()

		await waitFor(() => {
			expect(session.render).toHaveBeenCalled()
		})

		fireEvent.click(screen.getByRole("tab", { name: "Filters" }))

		await waitFor(() => {
			expect(session.filterThumbnails).toHaveBeenCalledTimes(1)
		})

		const first = (await session.filterThumbnails.mock.results[0]?.value) as unknown as FakeBitmap[]

		fireEvent.click(screen.getByRole("tab", { name: "Adjust" }))
		fireEvent.click(screen.getByRole("tab", { name: "Filters" }))

		expect(session.filterThumbnails).toHaveBeenCalledTimes(1)

		fireEvent.click(screen.getByRole("tab", { name: "Crop" }))
		fireEvent.click(screen.getByRole("button", { name: "Flip horizontally" }))
		fireEvent.click(screen.getByRole("tab", { name: "Filters" }))

		await waitFor(() => {
			expect(session.filterThumbnails).toHaveBeenCalledTimes(2)
		})
		await waitFor(() => {
			expect(first[0]?.close.mock.calls.length).toBeGreaterThan(0)
		})
	})

	it("shows the whole frame while cropping and nudges the crop from the keyboard", async () => {
		const { session } = mount()

		await waitFor(() => {
			expect(session.render).toHaveBeenCalled()
		})

		fireEvent.click(screen.getByRole("tab", { name: "Crop" }))
		fireEvent.click(screen.getByRole("button", { name: "Square" }))

		expect(lastRendered(session).geometry.crop).toEqual({ x: 0, y: 0, width: 1, height: 1 })

		fireEvent.keyDown(screen.getByRole("button", { name: "Right edge" }), { key: "ArrowLeft" })
		fireEvent.click(screen.getByRole("tab", { name: "Adjust" }))

		const crop = lastRendered(session).geometry.crop

		// Square on a 4:3 frame is 0.75 of its width; the edge pulled in, the height follows to stay square.
		expect(crop.width).toBeCloseTo(0.74)
		expect(crop.height).toBeCloseTo(0.74 / 0.75)
	})

	it("straightens with the crop shrinking to fit, and gives it back on straightening back", async () => {
		const { session } = mount()

		await waitFor(() => {
			expect(session.render).toHaveBeenCalled()
		})

		fireEvent.click(screen.getByRole("tab", { name: "Crop" }))

		const straighten = slider("Straighten")

		act(() => {
			straighten.focus()
		})
		fireEvent.keyDown(straighten, { key: "ArrowRight", shiftKey: true })
		fireEvent.click(screen.getByRole("tab", { name: "Adjust" }))

		const tilted = lastRendered(session).geometry

		expect(tilted.angle).toBe(5)
		expect(tilted.crop.width).toBeLessThan(1)

		fireEvent.click(screen.getByRole("tab", { name: "Crop" }))
		act(() => {
			slider("Straighten").focus()
		})
		fireEvent.keyDown(slider("Straighten"), { key: "ArrowLeft", shiftKey: true })
		fireEvent.click(screen.getByRole("tab", { name: "Adjust" }))

		expect(lastRendered(session).geometry).toMatchObject({ angle: 0, crop: { x: 0, y: 0, width: 1, height: 1 } })
	})

	it("draws a pen stroke on release only and erases it by a click", async () => {
		const { session } = mount()

		await waitFor(() => {
			expect(session.render).toHaveBeenCalled()
		})

		resizeStage(400, 300)
		fireEvent.click(screen.getByRole("tab", { name: "Markup" }))

		const surface = screen.getByRole("application", { name: "Drawing surface" })
		const renders = session.render.mock.calls.length

		fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
		fireEvent.pointerMove(surface, { pointerId: 1, clientX: 50, clientY: 10 })
		fireEvent.pointerMove(surface, { pointerId: 1, clientX: 90, clientY: 10 })

		expect(session.render.mock.calls.length).toBe(renders)

		fireEvent.pointerUp(surface, { pointerId: 1, clientX: 90, clientY: 10 })

		const drawn = lastRendered(session).markup

		expect(drawn).toHaveLength(1)
		expect(drawn[0]).toMatchObject({ kind: "pen", points: [10, 10, 50, 10, 90, 10] })

		fireEvent.click(screen.getByRole("button", { name: "Eraser" }))
		fireEvent.pointerDown(surface, { button: 0, pointerId: 2, clientX: 50, clientY: 11 })
		fireEvent.pointerUp(surface, { pointerId: 2, clientX: 50, clientY: 11 })

		expect(lastRendered(session).markup).toHaveLength(0)
	})

	it("places text and leaves the item out of the picture while it is edited", async () => {
		const { session } = mount()

		await waitFor(() => {
			expect(session.render).toHaveBeenCalled()
		})

		resizeStage(400, 300)
		fireEvent.click(screen.getByRole("tab", { name: "Markup" }))
		fireEvent.click(screen.getByRole("button", { name: "Text" }))

		const surface = screen.getByRole("application", { name: "Drawing surface" })

		fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 20, clientY: 30 })

		const field = screen.getByRole("textbox", { name: "Text on the image" })

		fireEvent.change(field, { target: { value: "Hello" } })
		fireEvent.keyDown(field, { key: "Enter" })

		const [item] = lastRendered(session).markup

		expect(item).toMatchObject({ kind: "text", text: "Hello", at: [20, 30] })

		fireEvent.pointerDown(surface, { button: 0, pointerId: 2, clientX: 22, clientY: 32 })

		expect(screen.getByRole("textbox", { name: "Text on the image" })).toHaveProperty("value", "Hello")
		expect(lastRendered(session).markup).toHaveLength(0)
	})

	it("compares while the button is held", async () => {
		const { session } = mount()

		await waitFor(() => {
			expect(session.render).toHaveBeenCalled()
		})

		const button = screen.getByRole("button", { name: "Hold to compare with the original" })

		fireEvent.pointerDown(button, { button: 0, pointerId: 1 })

		expect(session.render.mock.calls.at(-1)?.[1]).toEqual({ compare: true })

		fireEvent.pointerUp(button, { pointerId: 1 })

		expect(session.render.mock.calls.at(-1)?.[1]).toEqual({ compare: false })
	})

	it("registers its commands while mounted: revert is one undoable step", async () => {
		const { session, commandsRef, view } = mount()

		await waitFor(() => {
			expect(session.render).toHaveBeenCalled()
		})

		fireEvent.click(screen.getByRole("tab", { name: "Filters" }))
		fireEvent.click(screen.getByRole("button", { name: "Noir" }))

		act(() => {
			commandsRef.current?.revert()
		})

		expect(lastRendered(session).filter).toBeNull()

		act(() => {
			commandsRef.current?.undo()
		})

		expect(lastRendered(session).filter).toBe("noir")

		view.unmount()

		expect(commandsRef.current).toBeNull()
	})

	it("changes nothing while locked", async () => {
		const { session, commandsRef, view } = mount({ locked: true })

		await waitFor(() => {
			expect(session.render).toHaveBeenCalled()
		})

		expect(view.container.querySelector("[data-preview-surface]")?.hasAttribute("inert")).toBe(true)

		const renders = session.render.mock.calls.length

		act(() => {
			commandsRef.current?.revert()
			commandsRef.current?.undo()
		})

		expect(session.render.mock.calls.length).toBe(renders)
	})
})
