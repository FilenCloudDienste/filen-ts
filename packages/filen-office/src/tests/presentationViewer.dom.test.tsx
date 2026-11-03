// @vitest-environment happy-dom
import { act, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { slideRef, type SlideRef } from "../core/presentation/model"
import type { BitmapLike, PresentationEvent, PresentationSessionApi, SlideRender } from "../dom/presentation/protocol"
import { presentationActions } from "../react/presentation/links"
import { NotesPanel } from "../react/presentation/notes/NotesPanel"
import { SlideRail } from "../react/presentation/rail/SlideRail"
import { railKeyTarget, railRange, revealOffset } from "../react/presentation/rail/window"
import type { ShowController } from "../react/presentation/show/controller"
import { showSequence, StaticShow } from "../react/presentation/show/static"
import { SlideView, type SlidePainter } from "../react/presentation/SlideView"
import {
	createPresentationStore,
	type PresentationConnection,
	type PresentationHost,
	type PresentationStore,
	type PresentationThumb
} from "../react/presentation/store"
import { fixtureDeck } from "./fixtures/presentation/deck"
import { fixtureSlideRender } from "./fixtures/presentation/slideRender"

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

const SIZE = { cx: 12_192_000, cy: 6_858_000 }

class Bitmap implements BitmapLike {
	static open = 0
	closed = false
	readonly width: number
	readonly height: number

	constructor(width = 192, height = 108) {
		this.width = width
		this.height = height
		Bitmap.open++
	}

	close(): void {
		if (!this.closed) Bitmap.open--

		this.closed = true
	}
}

interface FakeHost {
	readonly host: PresentationHost
	emit(event: PresentationEvent): void
	readonly session: PresentationSessionApi
	readonly render: ReturnType<typeof vi.fn>
	readonly thumbnails: ReturnType<typeof vi.fn>
	readonly unlock: ReturnType<typeof vi.fn>
	readonly dispose: ReturnType<typeof vi.fn>
}

function slideList(count: number, hidden: (index: number) => boolean = () => false) {
	return Array.from({ length: count }, (_, index) => ({ ref: slideRef(10 + index), hidden: hidden(index) }))
}

function fakeHost(renderOf: (ref: SlideRef) => SlideRender): FakeHost {
	let listener: ((event: PresentationEvent) => void) | undefined
	const render = vi.fn((refs: readonly SlideRef[]) => Promise.resolve(refs.map(renderOf)))
	const thumbnails = vi.fn(() => Promise.resolve())
	const unlock = vi.fn()
	const dispose = vi.fn()
	const session = { render, thumbnails, close: vi.fn() } as unknown as PresentationSessionApi
	const host: PresentationHost = (_source, onEvent) => {
		listener = onEvent

		return { session, unlock, dispose } satisfies PresentationConnection
	}

	return { host, emit: event => listener?.(event), session, render, thumbnails, unlock, dispose }
}

function openInfo(count: number, hidden: (index: number) => boolean = () => false) {
	return {
		format: "pptx",
		variant: "pptx",
		slides: slideList(count, hidden),
		size: SIZE,
		notesSize: { cx: 6_858_000, cy: 9_144_000 },
		sections: [],
		customShows: [],
		protection: { writeProtected: false, encrypted: false },
		gate: [],
		editable: true,
		locks: 0,
		packageBytes: 1000,
		source: "bytes"
	} as const
}

function plainRender(ref: SlideRef, revision = 0): SlideRender {
	const deck = fixtureDeck(1)
	const base = fixtureSlideRender(deck, 0)

	return { ...base, ref, index: Number(ref) - 10, revision }
}

async function flush(turns = 5): Promise<void> {
	await act(async () => {
		for (let i = 0; i < turns; i++) await Promise.resolve()
	})
}

function openStore(options: { renderWindow?: number; thumbBytes?: number } = {}) {
	const fake = fakeHost(ref => plainRender(ref))
	const store = createPresentationStore({
		host: fake.host,
		source: { kind: "bytes", bytes: new Uint8Array(1) },
		options: { format: "pptx", fileName: "deck.pptx" },
		...options
	})
	const unsubscribe = store.subscribe(() => undefined)

	return { fake, store, unsubscribe }
}

describe("presentation store", () => {
	beforeEach(() => {
		Bitmap.open = 0
	})

	it("keeps renders only inside the window and asks for the missing ones", async () => {
		const { fake, store } = openStore({ renderWindow: 2 })

		fake.emit({ type: "opened", info: openInfo(2000) })
		await flush(20)

		// One slide per call, the current one first.
		expect(fake.render.mock.calls).toEqual([[[slideRef(10)]], [[slideRef(11)]], [[slideRef(12)]]])
		expect(store.getSnapshot().renders.size).toBe(3)

		// A render streamed for a slide far away is not kept.
		fake.emit({ type: "slides", renders: [plainRender(slideRef(1500))], final: true })
		await flush()

		expect(store.getSnapshot().renders.has(slideRef(1500))).toBe(false)
		expect(store.getSnapshot().status).toBe("ready")

		store.setWindow(1000)
		await flush(40)

		const renders = store.getSnapshot().renders

		expect([...renders.keys()].map(Number).sort((a, b) => a - b)).toEqual([1008, 1009, 1010, 1011, 1012])
		store.dispose()
	})

	it("closes thumbnails it evicts, replaces or cannot use, and every one on dispose", async () => {
		const bytes = 192 * 108 * 4
		const { fake, store } = openStore({ thumbBytes: bytes * 3 })

		fake.emit({ type: "opened", info: openInfo(50) })
		store.requestThumbnails([slideRef(10), slideRef(11), slideRef(12), slideRef(13)], 192)
		await flush()

		expect(fake.thumbnails).toHaveBeenCalledTimes(1)
		expect(fake.thumbnails).toHaveBeenCalledWith([slideRef(10), slideRef(11), slideRef(12), slideRef(13)], 192)

		const items = [10, 11, 12, 13].map(n => ({ slide: slideRef(n), revision: 0, bitmap: new Bitmap() }))

		fake.emit({ type: "thumbs", items })
		await flush()

		// Over budget: the least recently used is closed.
		expect(items[0]?.bitmap).toMatchObject({ closed: true })
		expect(store.getSnapshot().thumbs.size).toBe(3)
		expect(Bitmap.open).toBe(3)

		// Older revision than the one held: closed at once. Unknown slide: closed at once.
		const older = new Bitmap()
		const stranger = new Bitmap()

		fake.emit({
			type: "thumbs",
			items: [
				{ slide: slideRef(11), revision: -1, bitmap: older },
				{ slide: slideRef(999), revision: 0, bitmap: stranger }
			]
		})
		expect(older.closed && stranger.closed).toBe(true)

		// A newer one replaces (and closes) the old one.
		const newer = new Bitmap()

		fake.emit({ type: "thumbs", items: [{ slide: slideRef(12), revision: 1, bitmap: newer }] })
		expect(items[2]?.bitmap).toMatchObject({ closed: true })
		expect(store.getSnapshot().thumbs.get(slideRef(12))?.bitmap).toBe(newer)

		store.dispose()
		expect(Bitmap.open).toBe(0)
		expect(fake.dispose).toHaveBeenCalledTimes(1)
	})

	it("asks again only for stale or missing thumbnails", async () => {
		const { fake, store } = openStore()

		fake.emit({ type: "opened", info: openInfo(5) })
		store.requestThumbnails([slideRef(10), slideRef(11)], 192)
		store.requestThumbnails([slideRef(10), slideRef(11)], 192)
		await flush()

		expect(fake.thumbnails).toHaveBeenCalledTimes(1)

		fake.emit({ type: "thumbs", items: [10, 11].map(n => ({ slide: slideRef(n), revision: 0, bitmap: new Bitmap() })) })
		await flush()
		store.requestThumbnails([slideRef(10), slideRef(11)], 192)
		await flush()

		expect(fake.thumbnails).toHaveBeenCalledTimes(1)

		fake.emit({ type: "changed", revision: 1, dirty: true, slides: [slideRef(11)] })

		expect(store.getSnapshot().thumbs.get(slideRef(11))?.stale).toBe(true)
		expect(store.getSnapshot().dirty).toBe(true)

		store.requestThumbnails([slideRef(10), slideRef(11)], 192)
		await flush()

		expect(fake.thumbnails).toHaveBeenLastCalledWith([slideRef(11)], 192)
		store.dispose()
	})

	it("drops the thumbnails and renders of slides a change removed", async () => {
		const { fake, store } = openStore()

		fake.emit({ type: "opened", info: openInfo(3) })
		await flush()

		const bitmap = new Bitmap()

		fake.emit({ type: "thumbs", items: [{ slide: slideRef(12), revision: 0, bitmap }] })
		fake.emit({ type: "changed", revision: 2, dirty: true, slides: [], info: { slides: slideList(2) } })

		expect(bitmap.closed).toBe(true)
		expect(store.getSnapshot().slides).toHaveLength(2)
		expect(store.getSnapshot().renders.has(slideRef(12))).toBe(false)
		store.dispose()
	})

	it("asks for a password, retries a wrong one and opens", async () => {
		const { fake, store } = openStore()

		fake.emit({ type: "error", reason: "needsPassword", message: "" })
		expect(store.getSnapshot()).toMatchObject({ status: "password", password: { wrong: false } })

		store.unlock("nope")
		expect(fake.unlock).toHaveBeenCalledWith("nope")
		// The prompt stays up while the worker checks the password.
		expect(store.getSnapshot()).toMatchObject({ status: "loading", password: { wrong: false } })
		fake.emit({ type: "error", reason: "wrongPassword", message: "" })
		expect(store.getSnapshot()).toMatchObject({ status: "password", password: { wrong: true } })

		store.unlock("tika")
		fake.emit({ type: "opened", info: openInfo(1) })
		expect(store.getSnapshot()).toMatchObject({ status: "ready", password: undefined })
		expect(fake.dispose).not.toHaveBeenCalled()
		store.dispose()
	})

	it("ends the session on any other error and keeps notices typed and unique", () => {
		const { fake, store } = openStore()

		fake.emit({ type: "notice", notice: { kind: "macros" } })
		fake.emit({ type: "notice", notice: { kind: "macros" } })
		expect(store.getSnapshot().notices).toEqual([{ kind: "macros" }])
		store.dismissNotice({ kind: "macros" })
		expect(store.getSnapshot().notices).toEqual([])

		fake.emit({ type: "error", reason: "malformed", message: "bad zip" })
		expect(store.getSnapshot()).toMatchObject({ status: "error", error: { reason: "malformed", message: "bad zip" } })
		expect(fake.dispose).toHaveBeenCalledTimes(1)
		store.dispose()
	})

	it("waits for the faces sent before renders", async () => {
		let resolveFace: (value: boolean) => void = () => undefined
		const fontHost = {
			addBytes: vi.fn(() => new Promise<boolean>(resolve => (resolveFace = resolve))),
			addLocal: vi.fn(() => Promise.resolve(true)),
			remove: vi.fn()
		}
		const fake = fakeHost(ref => plainRender(ref))
		const store: PresentationStore = createPresentationStore({
			host: fake.host,
			source: { kind: "bytes", bytes: new Uint8Array(1) },
			options: { format: "pptx", fileName: "a.pptx" },
			fontHost,
			renderWindow: 0
		})

		store.subscribe(() => undefined)
		fake.emit({
			type: "fonts",
			faces: [{ kind: "bytes", face: { family: "fo-x", weight: 400, style: "normal" } as never, bytes: new Uint8Array(4) }]
		})
		fake.emit({ type: "opened", info: openInfo(1) })
		await flush()

		expect(store.getSnapshot().renders.size).toBe(0)

		resolveFace(true)
		await flush()

		expect(store.getSnapshot().renders.size).toBe(1)
		store.dispose()
		expect(fontHost.remove).toHaveBeenCalledWith("fo-x")
	})
})

describe("rail window", () => {
	it("mounts the items in view plus overscan only", () => {
		expect(railRange(2000, 100, 0, 500, 3)).toEqual({ first: 0, last: 7 })
		expect(railRange(2000, 100, 100_000, 500, 3)).toEqual({ first: 997, last: 1007 })
		expect(railRange(2000, 100, 199_600, 500, 3)).toEqual({ first: 1993, last: 1999 })
		expect(railRange(0, 100, 0, 500, 3)).toEqual({ first: 0, last: -1 })
	})

	it("reveals an item outside the view and moves by keys", () => {
		expect(revealOffset(10, 100, 0, 500)).toBe(600)
		expect(revealOffset(2, 100, 500, 500)).toBe(200)
		expect(revealOffset(6, 100, 500, 500)).toBeUndefined()
		expect(railKeyTarget("ArrowDown", 0, 5, 3, true)).toBe(1)
		expect(railKeyTarget("ArrowRight", 0, 5, 3, true)).toBeUndefined()
		expect(railKeyTarget("ArrowRight", 4, 5, 3, false)).toBe(4)
		expect(railKeyTarget("PageDown", 0, 5, 3, true)).toBe(3)
		expect(railKeyTarget("End", 0, 5, 3, true)).toBe(4)
		expect(railKeyTarget("Home", 3, 5, 3, true)).toBe(0)
	})
})

describe("presentation viewer components", () => {
	let host: HTMLDivElement
	let root: Root

	beforeEach(() => {
		host = document.createElement("div")
		document.body.appendChild(host)
		root = createRoot(host)
		vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600)
		vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800)
	})

	afterEach(() => {
		act(() => root.unmount())
		host.remove()
	})

	function renderRail(props: Partial<Parameters<typeof SlideRail>[0]> = {}) {
		const requestThumbnails = vi.fn()
		const onSelect = vi.fn()
		const slides = slideList(2000, index => index % 7 === 1)

		act(() =>
			root.render(
				<SlideRail
					slides={slides}
					thumbs={new Map<SlideRef, PresentationThumb>()}
					aspect={0.5625}
					current={0}
					onSelect={onSelect}
					requestThumbnails={requestThumbnails}
					label="Slides"
					slideLabel={(index, count, hidden) => `Slide ${String(index + 1)} of ${String(count)}${hidden ? ", hidden" : ""}`}
					{...props}
				/>
			)
		)

		return { requestThumbnails, onSelect, slides }
	}

	it("mounts only the rail window of a 2000-slide deck and asks thumbnails for it", async () => {
		const { requestThumbnails } = renderRail()

		await act(async () => {
			await new Promise(resolve => requestAnimationFrame(resolve))
		})

		const options = host.querySelectorAll("[role=option]")

		// 600 px over 102 px items (90 px thumbnails + gap): 6 in view, 3 overscan.
		expect(options.length).toBeLessThanOrEqual(12)
		expect(options[0]?.getAttribute("aria-setsize")).toBe("2000")
		expect(host.querySelector(".fo-slide-rail-content")?.getAttribute("style")).toContain(`height: ${String(2000 * 102)}px`)

		const asked = requestThumbnails.mock.calls.at(-1)?.[0] as SlideRef[]

		expect(asked.length).toBe(options.length)
	})

	it("dims hidden slides and names them, and keeps the current one mounted", () => {
		renderRail()

		const hidden = host.querySelector("[data-fo-index='1']")

		expect(hidden?.hasAttribute("data-fo-hidden")).toBe(true)
		expect(hidden?.getAttribute("aria-label")).toBe("Slide 2 of 2000, hidden")
		expect(host.querySelector("[data-fo-index='2']")?.hasAttribute("data-fo-hidden")).toBe(false)

		renderRail({ current: 1500 })

		const listbox = host.querySelector("[role=listbox]")
		const active = listbox?.getAttribute("aria-activedescendant") ?? ""

		expect(host.querySelector(`[id='${active}']`)?.getAttribute("aria-selected")).toBe("true")
	})

	it("selects by click and keys", () => {
		const { onSelect } = renderRail({ current: 3 })
		const listbox = host.querySelector<HTMLElement>("[role=listbox]")

		act(() => listbox?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })))
		expect(onSelect).toHaveBeenLastCalledWith(4)
		act(() => listbox?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })))
		expect(onSelect).toHaveBeenLastCalledWith(1999)
		act(() => host.querySelector<HTMLElement>("[data-fo-index='2']")?.click())
		expect(onSelect).toHaveBeenLastCalledWith(2)
	})

	it("collapses and resizes the notes by keyboard and pointer, within its bounds", () => {
		const onHeight = vi.fn()

		act(() =>
			root.render(
				<NotesPanel
					text={"First line\nSecond line"}
					label="Notes"
					expandLabel="Show notes"
					collapseLabel="Hide notes"
					resizeLabel="Resize notes"
					emptyText="No notes"
					defaultHeight={100}
					minHeight={60}
					maxHeight={200}
					onHeightChange={onHeight}
				/>
			)
		)

		const separator = host.querySelector<HTMLElement>("[role=separator]")
		const body = host.querySelector<HTMLElement>(".fo-notes-body")

		expect(host.querySelectorAll(".fo-notes-paragraph")).toHaveLength(2)
		expect(separator?.getAttribute("aria-valuenow")).toBe("100")

		act(() => separator?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })))
		expect(separator?.getAttribute("aria-valuenow")).toBe("108")
		act(() => separator?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })))
		expect(separator?.getAttribute("aria-valuenow")).toBe("200")
		act(() => separator?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })))
		expect(body?.style.height).toBe("60px")

		act(() => separator?.dispatchEvent(new PointerEvent("pointerdown", { button: 0, pointerId: 1, clientY: 300, bubbles: true })))
		act(() => separator?.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientY: 250, bubbles: true })))
		act(() => separator?.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientY: 250, bubbles: true })))
		expect(separator?.getAttribute("aria-valuenow")).toBe("110")
		expect(onHeight).toHaveBeenLastCalledWith(110)

		const toggle = host.querySelector<HTMLButtonElement>(".fo-notes-toggle")

		expect(toggle?.getAttribute("aria-expanded")).toBe("true")
		act(() => toggle?.click())
		expect(toggle?.getAttribute("aria-expanded")).toBe("false")
		expect(toggle?.textContent).toBe("Show notes")
		expect(host.querySelector<HTMLElement>(".fo-notes-body")?.hidden).toBe(true)
		expect(host.querySelector("[role=separator]")).toBeNull()
	})

	it("shows the empty text for a slide without notes", () => {
		act(() =>
			root.render(
				<NotesPanel
					text=""
					label="Notes"
					expandLabel="Show"
					collapseLabel="Hide"
					resizeLabel="Resize"
					emptyText="No notes"
				/>
			)
		)

		expect(host.querySelector("[data-fo-empty]")?.textContent).toBe("No notes")
	})

	// Draws each layer as a box tagged with its index and its text as runs with their link index.
	const painter: SlidePainter = vi.fn((render: SlideRender, context) => {
		const root = context.document.createElement("div")

		render.layers.forEach((layer, index) => {
			const element = context.document.createElement("div")

			element.dataset["foLayer"] = String(index)

			if (layer.text !== undefined && layer.text.links.length > 0) {
				const run = context.document.createElement("span")

				run.dataset["foLink"] = "0"
				run.textContent = "link"
				element.appendChild(run)
			}

			root.appendChild(element)
		})

		return { root, release: vi.fn() }
	})

	function linkedRender(): SlideRender {
		const base = plainRender(slideRef(10))
		const [first, ...rest] = base.layers

		if (first?.text === undefined) throw new Error("fixture")

		return {
			...base,
			layers: [
				{ ...first, text: { ...first.text, links: [{ kind: "external", href: "https://example.com", tooltip: undefined }] } },
				...rest.map((layer, index) =>
					index === 1
						? ({
								...layer,
								actions: {
									click: { kind: "slide", slide: slideRef(12) },
									hover: { kind: "url", href: "https://hover.example" }
								}
							} as const)
						: layer
				)
			]
		}
	}

	it("scales the slide paper to fit and paints through the compositor", () => {
		const render = plainRender(slideRef(10))
		const onScale = vi.fn()

		act(() =>
			root.render(
				<SlideView
					render={render}
					size={SIZE}
					painter={painter}
					label="Slide 1 of 3"
					onScale={onScale}
				/>
			)
		)

		// 800 × 600 around a 1280 × 720 slide: width-bound.
		expect(onScale).toHaveBeenLastCalledWith(0.625)
		expect(host.querySelector<HTMLElement>(".fo-slide-frame")?.style.width).toBe("800px")
		expect(host.querySelector<HTMLElement>(".fo-slide-paper")?.style.transform).toBe("scale(0.625)")
		expect(host.querySelectorAll(".fo-slide-content [data-fo-layer]")).toHaveLength(render.layers.length)
		expect(host.querySelector("[role=group]")?.getAttribute("aria-label")).toBe("Slide 1 of 3")
	})

	it("keeps the paint across a render that paints alike, and releases it for a pending paper", () => {
		const first = plainRender(slideRef(10))
		const release = vi.fn()
		let painted = 0
		const tracking: SlidePainter = (render, context) => {
			painted++

			return { ...painter(render, context), release }
		}

		act(() =>
			root.render(
				<SlideView
					render={first}
					size={SIZE}
					painter={tracking}
					label="s"
				/>
			)
		)
		act(() =>
			root.render(
				<SlideView
					render={plainRender(slideRef(10), 1)}
					size={SIZE}
					painter={tracking}
					label="s"
				/>
			)
		)
		expect(release).toHaveBeenCalledTimes(0)
		expect(painted).toBe(1)
		act(() =>
			root.render(
				<SlideView
					render={undefined}
					size={SIZE}
					painter={tracking}
					label="s"
				/>
			)
		)
		expect(release).toHaveBeenCalledTimes(1)
		expect(host.querySelector(".fo-slide-frame")?.hasAttribute("data-fo-pending")).toBe(true)
	})

	it("follows click actions and text links through the policy, and wires no hover", () => {
		const navigate = vi.fn()
		const confirm = vi.fn()
		const actions = presentationActions({ link: { allow: () => true, open: vi.fn() }, navigate, confirm })

		act(() =>
			root.render(
				<SlideView
					render={linkedRender()}
					size={SIZE}
					painter={painter}
					label="s"
					actions={actions}
					actionLabel={action => (action.kind === "slide" ? "Go to slide 3" : "action")}
				/>
			)
		)

		const hotspots = host.querySelectorAll<HTMLButtonElement>(".fo-slide-hotspot")

		expect(hotspots).toHaveLength(1)
		expect(hotspots[0]?.getAttribute("aria-label")).toBe("Go to slide 3")

		act(() => hotspots[0]?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })))
		expect(navigate).not.toHaveBeenCalled()
		act(() => hotspots[0]?.click())
		expect(navigate).toHaveBeenCalledWith({ kind: "slide", slide: slideRef(12) })

		act(() => host.querySelector<HTMLElement>("[data-fo-layer='0'] [data-fo-link]")?.click())
		expect(confirm.mock.calls[0]?.[0]).toBe("example.com")
	})

	it("needs Mod+click to follow an action in the editor", () => {
		const navigate = vi.fn()
		const actions = presentationActions({ link: { allow: () => true, open: vi.fn() }, navigate })

		act(() =>
			root.render(
				<SlideView
					render={linkedRender()}
					size={SIZE}
					painter={painter}
					label="s"
					actions={actions}
					mode="edit"
				/>
			)
		)

		const hotspot = host.querySelector<HTMLButtonElement>(".fo-slide-hotspot")

		act(() => hotspot?.click())
		expect(navigate).not.toHaveBeenCalled()
		act(() => hotspot?.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true, metaKey: true, button: 0 })))
		expect(navigate).toHaveBeenCalledTimes(1)
	})

	it("steps a static show over visible slides and ends on Escape without letting it through", () => {
		const slides = slideList(4, index => index === 1)
		const renders = new Map(slides.map(slide => [slide.ref, plainRender(slide.ref)]))
		const onEnd = vi.fn()
		const onSlide = vi.fn()
		const outer = vi.fn()
		const controller = createRef<ShowController>()

		document.body.addEventListener("keydown", outer)
		act(() =>
			root.render(
				<StaticShow
					slides={slides}
					customShows={[]}
					renders={renders}
					size={SIZE}
					painter={painter}
					onSlide={onSlide}
					onEnd={onEnd}
					label="Slide show"
					slideLabel={(index, count) => `Slide ${String(index + 1)} of ${String(count)}`}
					ref={controller}
				/>
			)
		)

		const stage = host.querySelector<HTMLElement>(".fo-show-stage")
		const key = (k: string): void => {
			act(() => {
				stage?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }))
			})
		}

		expect(onSlide).toHaveBeenLastCalledWith(0)
		key("ArrowRight")
		// The hidden slide 2 is skipped.
		expect(onSlide).toHaveBeenLastCalledWith(2)
		key("b")
		expect(stage?.dataset["foScreen"]).toBe("black")
		key("b")
		expect(stage?.dataset["foScreen"]).toBe("slide")
		key("2")
		key("Enter")
		// A jump may show a hidden slide.
		expect(onSlide).toHaveBeenLastCalledWith(1)
		key("ArrowRight")
		expect(onSlide).toHaveBeenLastCalledWith(2)
		key("ArrowLeft")
		expect(onSlide).toHaveBeenLastCalledWith(0)
		key("Escape")
		expect(onEnd).toHaveBeenCalledTimes(1)
		expect(outer).not.toHaveBeenCalled()
		document.body.removeEventListener("keydown", outer)
	})

	it("names a static show's stage only by the page's label and announces each slide politely", () => {
		const slides = slideList(2)
		const renders = new Map(slides.map(slide => [slide.ref, plainRender(slide.ref)]))

		act(() =>
			root.render(
				<StaticShow
					slides={slides}
					customShows={[]}
					renders={renders}
					size={SIZE}
					painter={painter}
					onEnd={() => undefined}
					label="Slide show"
					slideLabel={(index, count) => `Slide ${String(index + 1)} of ${String(count)}`}
				/>
			)
		)

		const stage = host.querySelector<HTMLElement>(".fo-show-stage")
		const live = stage?.querySelector<HTMLElement>("[aria-live]")

		expect(stage?.getAttribute("role")).toBe("region")
		expect(stage?.getAttribute("aria-label")).toBe("Slide show")
		expect(stage?.hasAttribute("aria-roledescription")).toBe(false)
		expect(live?.getAttribute("aria-live")).toBe("polite")
		expect(live?.textContent).toBe("Slide 1 of 2")
		act(() => {
			stage?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
		})
		expect(live?.textContent).toBe("Slide 2 of 2")
	})

	it("runs a custom show and returns after it when asked", () => {
		const slides = slideList(5)
		const renders = new Map<SlideRef, SlideRender>()
		const onSlide = vi.fn()
		const controller = createRef<ShowController>()

		act(() =>
			root.render(
				<StaticShow
					slides={slides}
					customShows={[{ id: 7, name: "Short", slides: [slideRef(14), slideRef(12)] }]}
					renders={renders}
					size={SIZE}
					painter={painter}
					onSlide={onSlide}
					onEnd={vi.fn()}
					label="Show"
					slideLabel={index => String(index)}
					ref={controller}
					policy={{ link: { allow: () => true, open: vi.fn() } }}
				/>
			)
		)

		expect(showSequence(slides, { id: 7, name: "Short", slides: [slideRef(14), slideRef(99), slideRef(12)] })).toEqual([4, 2])

		act(() => controller.current?.next())
		expect(onSlide).toHaveBeenLastCalledWith(1)
		act(() => void controller.current?.start({ customShow: 7 }))
		expect(onSlide).toHaveBeenLastCalledWith(4)
		act(() => controller.current?.next())
		expect(onSlide).toHaveBeenLastCalledWith(2)
	})
})
