import { describe, expect, it } from "vitest"
import type { SlideLayer, SlideRender, TextBody, TextSeed } from "@filen/office/core/presentation"
import { slideRef } from "@filen/office/core/presentation"
import {
	readShapeTexts,
	SHAPE_TRANSFORM_MAX_BODIES,
	shapeTransformOp,
	shapeTransformTargets
} from "@/features/presentation/lib/shapeTextTransform"

const SLIDE = slideRef(4)

function layer(
	id: number,
	role: SlideLayer["role"],
	body: "placeholder" | "textBox" | "shape" | "table" | undefined,
	extra = {}
): SlideLayer {
	return {
		shape: { slide: SLIDE, id },
		role,
		matrix: [1, 0, 0, 1, 0, 0],
		box: { id, xfrm: { x: 0, y: 0, cx: 10, cy: 10 }, ...(body === undefined ? {} : { body }) },
		...extra
	} as unknown as SlideLayer
}

function render(layers: readonly SlideLayer[]): SlideRender {
	return { ref: SLIDE, layers } as unknown as SlideRender
}

function lines(...texts: string[]): TextBody {
	return { bodyPr: {}, paragraphs: texts.map(text => ({ pPr: {}, runs: [{ kind: "r", text, rPr: {} }] })) }
}

// A session holding a body per shape id; `bodies` can be changed between reads.
function session(bodies: Map<number, TextBody>) {
	return {
		textSeed: (shape: { id: number }) => {
			const body = bodies.get(shape.id)

			return body === undefined ? Promise.reject(new Error("notFound")) : Promise.resolve({ body } as unknown as TextSeed)
		}
	}
}

describe("whole text bodies for the selection transform", () => {
	it("targets the selected text bodies, else every unlocked text body of the slide", () => {
		const slide = render([
			layer(1, "master", undefined),
			layer(2, "placeholder", "placeholder"),
			layer(3, "shape", "textBox"),
			layer(4, "table", "table"),
			layer(5, "picture", undefined),
			layer(6, "shape", "shape", { lock: "proofFailed" }),
			layer(3, "shape", "textBox")
		])

		expect(shapeTransformTargets(slide, []).map(target => target.shape.id)).toEqual([2, 3])
		expect(shapeTransformTargets(slide, [3, 5]).map(target => [target.shape.id, target.body])).toEqual([[3, "textBox"]])
	})

	it("reads each body's lines and lists the ones left out", async () => {
		const bodies = new Map<number, TextBody>([
			[1, lines("Quarterly results", "Revenue up 12 %")],
			[2, { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "fld", type: "slidenum", id: "{1}", text: "3", rPr: {} }] }] }],
			[3, lines("")],
			[4, lines("word ".repeat(900))]
		])
		const targets = [1, 2, 3, 4, 5].map(id => ({ shape: { slide: SLIDE, id }, body: "shape" as const }))
		const read = await readShapeTexts(session(bodies), targets, "rewrite")

		expect(read.ok && read.items.map(item => [item.shape.id, item.text])).toEqual([[1, "Quarterly results\nRevenue up 12 %"]])
		expect(read.ok && read.skipped.map(skip => [skip.shape.id, skip.reason])).toEqual([
			[2, "field"],
			[3, "empty"],
			[4, "too-long"],
			[5, "unreadable"]
		])
	})

	it("refuses more bodies than one request takes", async () => {
		const targets = Array.from({ length: SHAPE_TRANSFORM_MAX_BODIES + 1 }, (_, id) => ({
			shape: { slide: SLIDE, id },
			body: "shape" as const
		}))

		expect(await readShapeTexts(session(new Map()), targets, "rewrite")).toEqual({ ok: false, count: SHAPE_TRANSFORM_MAX_BODIES + 1 })
	})

	it("applies every body as one batch, and nothing once any changed", async () => {
		const bodies = new Map<number, TextBody>([
			[1, lines("Hello")],
			[2, lines("World", "Again")]
		])
		const targets = [1, 2].map(id => ({ shape: { slide: SLIDE, id }, body: "shape" as const }))
		const read = await readShapeTexts(session(bodies), targets, "translate")

		const [first, second] = read.ok ? read.items : []

		if (first === undefined || second === undefined) throw new Error("not read")

		const results = [
			{ item: first, text: "Hallo" },
			{ item: second, text: "Welt\nNochmal" }
		]
		const op = await shapeTransformOp(session(bodies), results)

		expect(op).toMatchObject({ family: "batch", kind: "batch" })
		expect(op !== "changed" && op.family === "batch" ? op.ops.map(inner => inner.kind) : null).toEqual(["setText", "setText"])

		bodies.set(2, lines("World", "Edited"))
		expect(await shapeTransformOp(session(bodies), results)).toBe("changed")
	})
})
