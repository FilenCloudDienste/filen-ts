import { describe, expect, it } from "vitest"
import { rgba } from "../core/drawingml/index"
import type { Paragraph, TextBody } from "../core/presentation/model"
import type { SlideRender } from "../core/presentation/output"
import { layoutBody, type TextEnvironment } from "../core/presentation/text/body"
import { PICTURE_BULLET_OBJECT } from "../core/presentation/text/page"
import { resolveBody, type BodyContext } from "../core/presentation/text/resolve"
import { OBJECT_FLOATS, OBJECT_INTS } from "../core/docx/layout/index"
import { MeasureCache } from "../core/text/index"
import { transferablesOf } from "../dom/presentation/protocol"
import { FakeMeasurer, testFont } from "./textFixtures"

// A picture bullet lays out in a bullet character's place, drawn transparent, with one page object over that place
// naming its picture (TextPage.images); the page and its objects cross the worker boundary with the render.

const CONTEXT: BodyContext = {
	listStyles: [],
	bodyPr: [],
	fonts: { color: color => (color.kind === "srgb" ? rgba(color.rgb, 1) : rgba("000000", 1)), typeface: typeface => typeface }
}

function environment(): TextEnvironment {
	const font = testFont()

	return {
		fonts: { resolve: request => ({ ...font, weight: request.bold ? 700 : 400, italic: request.italic }) },
		cache: new MeasureCache(new FakeMeasurer())
	}
}

function item(text: string, part: string | undefined): Paragraph {
	return {
		pPr: { marL: 342900, indent: -342900, ...(part === undefined ? {} : { bullet: { kind: "blip" as const, part } }) },
		runs: [{ kind: "r", text, rPr: { sz: 2400 } }]
	}
}

function laid(paragraphs: Paragraph[]) {
	const body: TextBody = { bodyPr: {}, paragraphs }

	return layoutBody(resolveBody(body, CONTEXT), { width: 600, height: 400 }, environment())
}

describe("picture bullets", () => {
	it("draws a picture over each picture bullet's place, sized to the bullet, its marker transparent", () => {
		const page = laid([item("One", "/ppt/media/image1.png"), item("Two", undefined), item("Three", "/ppt/media/image1.png")]).page

		expect(page.page.objectCount).toBe(2)
		expect([...page.page.objectKinds]).toEqual([PICTURE_BULLET_OBJECT, PICTURE_BULLET_OBJECT])
		expect(page.images).toEqual(["/ppt/media/image1.png"])
		expect([...page.page.objectInts]).toEqual([0, 1, 0, 0, 1, 2])

		const [x = -1, y = -1, w = 0, h = 0] = page.page.objectFloats.subarray(0, OBJECT_FLOATS)
		const third = page.page.objectFloats.subarray(OBJECT_FLOATS, 2 * OBJECT_FLOATS)

		// 24 pt: 32 px text, a 22.4 px picture at the paragraph's indent (0); the third paragraph's lower down.
		expect(x).toBe(0)
		expect(w).toBeCloseTo(22.4, 3)
		expect(h).toBeCloseTo(22.4, 3)
		expect(y).toBeGreaterThanOrEqual(0)
		expect(third[1] ?? 0).toBeGreaterThan(y)
		expect(page.page.objectInts.length).toBe(2 * OBJECT_INTS)
		// The marker's style draws nothing.
		expect(page.styles.some(style => style.alpha === 0)).toBe(true)
	})

	it("carries the page's objects and pictures across the worker boundary with the slide render", () => {
		const text = laid([item("One", "/ppt/media/image1.png")]).page
		const render = { layers: [{ text, drawing: { images: [] } }] } as unknown as SlideRender
		const message = { t: "event" as const, event: { type: "slides" as const, renders: [render] } }
		const transfer = transferablesOf(message as never)

		expect(transfer).toContain(text.page.objectFloats.buffer)

		const copy = structuredClone(message, { transfer } as unknown as Parameters<typeof structuredClone>[1])
		const arrived = copy.event.renders[0]?.layers[0]?.text

		expect(arrived?.images).toEqual(["/ppt/media/image1.png"])
		expect(arrived?.page.objectKinds[0]).toBe(PICTURE_BULLET_OBJECT)
	})
})
