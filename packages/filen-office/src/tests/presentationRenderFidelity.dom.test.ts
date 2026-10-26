// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import type { RenderEffects, SlideRender } from "../core/presentation/output"
import { DrawingList, IDENTITY, ItemKind, type Paint } from "../core/drawingml/displayList"
import { drawingData } from "../core/presentation/render/slide"
import { paintSlide, releaseSlidePictures } from "../react/presentation/paint/slide"
import type { PresentationSessionApi } from "../dom/presentation/protocol"
import type { DocxTextStyle } from "../core/docx/layout/index"
import { drawingTextCss, paintPage } from "../react/docx/paint/page"
import { fixtureTextPage } from "./fixtures/presentation/textPage"
import { FRAGMENT_INTS, FragmentFlag } from "../core/text/displayList"

// A text reflection where the engine has no -webkit-box-reflect (Firefox): a mirrored, masked, inert copy of the span.

describe("page painter: text reflection without -webkit-box-reflect", () => {
	it("adds a mirrored copy under the span, faded by the reflection's mask, never focusable or read", () => {
		const view = document.defaultView

		if (view === null) throw new Error("no window")

		// The test window hands out a new CSS object on every read: its class answers for all of them.
		const supports = vi
			.spyOn(Object.getPrototypeOf(view.CSS) as { supports: (property: string, value: string) => boolean }, "supports")
			.mockReturnValue(false)
		const text = fixtureTextPage(["Quiz"])
		const reflection: RenderEffects = [
			{ kind: "reflection", blur: 0, startAlpha: 0.25, endAlpha: 0, endPos: 0.55, distance: 2, direction: 90 }
		]
		const painted = paintPage(text.page, {
			document,
			tables: { styles: text.styles.map(style => ({ ...style, effects: 0 })), decorations: text.decorations, links: text.links },
			paints: { paints: text.paints, strokes: text.strokes, textEffects: [reflection] }
		})
		const runs = [...painted.root.querySelectorAll<HTMLElement>(".fo-docx-run")]
		const mirror = runs.find(run => run.getAttribute("aria-hidden") === "true")

		supports.mockRestore()
		expect(runs).toHaveLength(2)
		expect(mirror?.textContent).toBe("Quiz")
		expect(mirror?.hasAttribute("inert")).toBe(true)
		expect(mirror?.style.transform).toContain("scaleY(-1)")
		expect(mirror?.getAttribute("style")).toContain("mask-image")
		// The span itself is the only one the selection and the hit tester see.
		expect(painted.texts.map(entry => entry.element)).not.toContain(mirror)
	})
})

describe("page painter: reflection of an upright cluster without -webkit-box-reflect", () => {
	it("flips the copy inside the span's own turn, keeping the origin the turn is about", () => {
		const view = document.defaultView

		if (view === null) throw new Error("no window")

		const supports = vi
			.spyOn(Object.getPrototypeOf(view.CSS) as { supports: (property: string, value: string) => boolean }, "supports")
			.mockReturnValue(false)
		const text = fixtureTextPage(["Quiz"])
		// The first fragment's flags (its fourth int) mark it an upright cluster of sideways text.
		const info = 0 * FRAGMENT_INTS + 3

		text.page.fragmentInts[info] = (text.page.fragmentInts[info] ?? 0) | FragmentFlag.UPRIGHT

		const reflection: RenderEffects = [
			{ kind: "reflection", blur: 0, startAlpha: 0.25, endAlpha: 0, endPos: 0.55, distance: 2, direction: 90 }
		]
		const painted = paintPage(text.page, {
			document,
			tables: { styles: text.styles.map(style => ({ ...style, effects: 0 })), decorations: text.decorations, links: text.links },
			paints: { paints: text.paints, strokes: text.strokes, textEffects: [reflection] }
		})
		const runs = [...painted.root.querySelectorAll<HTMLElement>(".fo-docx-run")]
		const span = runs.find(run => run.getAttribute("aria-hidden") !== "true")
		const mirror = runs.find(run => run.getAttribute("aria-hidden") === "true")

		supports.mockRestore()
		expect(span?.style.transform).toContain("rotate(-90deg)")
		expect(mirror?.style.transformOrigin).toBe(span?.style.transformOrigin)
		expect(mirror?.style.transform.startsWith(span?.style.transform.trim() ?? "-")).toBe(true)
		expect(mirror?.style.transform).toMatch(/translateY\(calc\(200% \+ 2px - 2 \* [\d.]+px\)\) scaleY\(-1\)$/)
	})
})

describe("text effects in the DOM painter", () => {
	const style = (paint: number): DocxTextStyle => ({
		font: "16px a",
		smallCapsFont: "16px a",
		color: "000000",
		kerning: false,
		letterSpacing: 0,
		scaleX: 1,
		shift: 0,
		ascent: 12,
		descent: 4,
		revision: 0,
		paint,
		effects: 0
	})
	const shadow: RenderEffects = [{ kind: "outerShadow", color: 0x65656599, blur: 2, dx: 0, dy: 2, sx: 1, sy: 1 }]
	const tables = (paint: Paint): { paints: Paint[]; strokes: []; textEffects: RenderEffects[] } => ({
		paints: [paint],
		strokes: [],
		textEffects: [shadow]
	})

	it("shadows gradient-filled glyphs with a drop-shadow filter, so the shadow never shows through their clipped fill", () => {
		const css = drawingTextCss(
			style(0),
			tables({
				kind: "linear",
				stops: { offsets: new Float32Array([0, 1]), colors: new Uint32Array([0xff0000ff, 0x00ff00ff]) },
				angle: 90,
				scaled: false
			})
		)

		expect(css).toContain("background-clip:text")
		expect(css).toContain("filter:drop-shadow(")
		expect(css).not.toContain("text-shadow")
	})

	it("keeps text-shadow for solid glyphs", () => {
		const css = drawingTextCss(style(0), tables({ kind: "solid", color: 0x112233ff }))

		expect(css).toContain("text-shadow:")
		expect(css).not.toContain("drop-shadow")
	})
})

describe("slide compositor: pictures a drawing carries as bytes", () => {
	function carrying(bytes: Uint8Array, bytesKey?: string): SlideRender {
		const list = new DrawingList()

		list.width = 100
		list.height = 50

		const image = list.image({
			partName: undefined,
			format: "png",
			handling: "native",
			svgPartName: undefined,
			crop: { left: 0, top: 0, right: 0, bottom: 0 },
			alpha: 1,
			grayscale: false,
			biLevel: -1,
			duotone: null,
			brightness: 0,
			contrast: 0,
			colorChange: null,
			bytes,
			...(bytesKey === undefined ? {} : { bytesKey })
		})

		list.addItem(ItemKind.IMAGE, IDENTITY, 0, 0, 100, 50, list.commandCount, list.coordCount, -1, -1, image, -1, 0, 0)

		return {
			ref: 1 as SlideRender["ref"],
			index: 0,
			revision: 0,
			hidden: false,
			background: drawingData(new DrawingList()),
			layers: [{ shape: { slide: 1, id: 2 } as never, drawing: drawingData(list), matrix: [1, 0, 0, 1, 0, 0], role: "picture" }],
			notesText: "",
			animated: false
		}
	}

	function urlSpies(): { created: string[]; revoked: string[]; restore: () => void } {
		const created: string[] = []
		const revoked: string[] = []
		const view = document.defaultView

		if (view === null) throw new Error("no window")

		const create = vi.spyOn(view.URL, "createObjectURL").mockImplementation(() => {
			created.push(`blob:test/${String(created.length)}`)

			return created[created.length - 1] ?? ""
		})
		const revoke = vi.spyOn(view.URL, "revokeObjectURL").mockImplementation(url => {
			revoked.push(url)
		})

		return {
			created,
			revoked,
			restore: () => {
				create.mockRestore()
				revoke.mockRestore()
			}
		}
	}

	it("shows a metafile's embedded bitmap through its own blob URL, revoked when the paint is released", () => {
		const spies = urlSpies()
		const painted = paintSlide(carrying(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), {
			document,
			session: undefined,
			signal: { aborted: false }
		})
		const root = painted.root as HTMLElement

		expect(root.querySelector("image")?.getAttribute("href")).toBe("blob:test/0")
		expect(root.querySelector("rect")).toBeNull()
		expect(spies.created).toHaveLength(1)

		painted.release()
		spies.restore()
		expect(spies.revoked).toEqual(["blob:test/0"])
	})

	it("shares one blob URL per bitmap across the slide views of a session, revoked with the session", () => {
		const api = {} as PresentationSessionApi
		const spies = urlSpies()
		const context = { document, session: api, signal: { aborted: false } }
		// Every render the worker sends carries its own copy of the bytes, under the name the worker gave the bitmap.
		const first = paintSlide(carrying(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "1"), context)
		const second = paintSlide(carrying(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "1"), context)
		const other = paintSlide(carrying(new Uint8Array([0x89, 0x50, 0x4e, 0x48]), "2"), context)
		const href = (painted: typeof first): string | null | undefined =>
			(painted.root as HTMLElement).querySelector("image")?.getAttribute("href")

		expect(spies.created).toEqual(["blob:test/0", "blob:test/1"])
		expect(href(first)).toBe("blob:test/0")
		expect(href(second)).toBe("blob:test/0")
		expect(href(other)).toBe("blob:test/1")

		first.release()
		second.release()
		other.release()
		expect(spies.revoked).toEqual([])

		releaseSlidePictures(api)
		spies.restore()
		expect(spies.revoked.sort()).toEqual(["blob:test/0", "blob:test/1"])
	})

	it("gives an unnamed bitmap its own blob URL even with a session, revoked when the paint is released", () => {
		const spies = urlSpies()
		const painted = paintSlide(carrying(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), {
			document,
			session: {} as PresentationSessionApi,
			signal: { aborted: false }
		})

		expect(spies.created).toEqual(["blob:test/0"])

		painted.release()
		spies.restore()
		expect(spies.revoked).toEqual(["blob:test/0"])
	})
})
