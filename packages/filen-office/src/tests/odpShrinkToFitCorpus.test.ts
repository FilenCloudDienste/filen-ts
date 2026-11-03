import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource } from "../core/opc/index"
import type { SlideRef } from "../core/presentation/model"
import { SERVICES, type EngineSession } from "../dom/presentation/engine"
import { openOdpCapability } from "../dom/presentation/engine/open/odp"
import { review } from "../dom/presentation/engine/review"
import { layoutShapeText } from "../dom/presentation/engine/text"
import { layoutBody } from "../core/presentation/text/body"
import { resolveBody } from "../core/presentation/text/resolve"
import { presentationTextServices } from "../dom/presentation/engine/view"
import { CORPUS_DIR } from "./corpusDir"
import { installTestRealm } from "./presentationExportFixtures"

// An ODP text box with style:shrink-to-fit, laid out with real metrics: its text shrinks until it fits the box, as
// LibreOffice 7.5 draws it (lo__trailing-paragraphs: 40 pt "textbox" and two empty paragraphs in a 2.75 × 1 cm box, one
// line each), never wrapped mid-word past the box.

const FILE = join(CORPUS_DIR, "odp", "lo__trailing-paragraphs.odp")

describe("an ODP body that shrinks its text to fit", () => {
	it.runIf(existsSync(FILE))("is laid out at the scale its text fits at: one line per paragraph", { timeout: 120_000 }, async () => {
		installTestRealm()

		const options = { format: "odp" as const, fileName: "deck.odp" }
		const outcome = await openOdpCapability.open({
			source: bytesSource(new Uint8Array(readFileSync(FILE))),
			sourceKind: "bytes",
			options
		})

		if (outcome.kind !== "opened") throw new Error(outcome.kind)

		const session: EngineSession = {
			s: 1,
			deck: outcome.deck,
			package: outcome.package,
			options,
			services: { ...SERVICES, text: presentationTextServices },
			rangeSource: undefined,
			schedule: () => undefined,
			emit: () => undefined,
			onClose: () => undefined
		}
		const slicing = { pause: () => Promise.resolve(), sliceMs: 50, now: () => Date.now() }
		const slide = session.deck.slides[0] as SlideRef

		await review({ session, signal: { aborted: false, onAbort: () => undefined }, lane: "background", slicing }, slide)

		const shape = session.deck.nodes.get(slide)?.shapes.find(each => each.text?.paragraphs.some(p => p.runs.length > 0))

		if (shape?.text === undefined) throw new Error("no text box")

		const laid = await layoutShapeText(session, { slide, id: shape.id }, shape.text, slicing)

		expect(laid.page.page.sourceTexts).toEqual(["textbox", "", ""])
		expect(laid.layout.lineCount).toBe(3)
	})

	// LibreOffice 7.5's own decisions on tika__testODP_NPE (TextFitToSizeScale as it loads the file): slide 11's body
	// shrunk (92%), slide 20's left at 100% (3% past its box counting its trailing empty paragraph, which the fit leaves
	// out).
	const NPE = join(CORPUS_DIR, "odp", "tika__testODP_NPE.odp")

	it.runIf(existsSync(NPE))("shrinks the bodies LibreOffice shrinks and leaves the ones it leaves", { timeout: 120_000 }, async () => {
		installTestRealm()

		const options = { format: "odp" as const, fileName: "deck.odp" }
		const outcome = await openOdpCapability.open({
			source: bytesSource(new Uint8Array(readFileSync(NPE))),
			sourceKind: "bytes",
			options
		})

		if (outcome.kind !== "opened") throw new Error(outcome.kind)

		const session: EngineSession = {
			s: 1,
			deck: outcome.deck,
			package: outcome.package,
			options,
			services: { ...SERVICES, text: presentationTextServices },
			rangeSource: undefined,
			schedule: () => undefined,
			emit: () => undefined,
			onClose: () => undefined
		}
		const slicing = { pause: () => Promise.resolve(), sliceMs: 50, now: () => Date.now() }
		const scaleOf = async (number: number): Promise<number> => {
			const slide = session.deck.slides[number - 1] as SlideRef

			await review({ session, signal: { aborted: false, onAbort: () => undefined }, lane: "background", slicing }, slide)

			const shape = session.deck.nodes.get(slide)?.shapes.find(each => each.text !== undefined && each.text.paragraphs.length > 4)

			if (shape?.text === undefined) throw new Error("no body")

			const found = await presentationTextServices.shapeText(session, { slide, id: shape.id }, slicing)

			if (found.kind !== "shapeText") throw new Error(found.kind)

			const resolved = resolveBody(shape.text, found.context)

			await found.prepare([])

			return layoutBody(resolved, found.box, found.environment, found.options).scale
		}

		// Shrunk until its last paragraph rewraps into two lines, as LibreOffice's 92% does (our glyphs rewrap it at 96%).
		const eleven = await scaleOf(11)

		expect(eleven).toBeLessThan(1)
		expect(eleven).toBeGreaterThan(0.9)
		expect(await scaleOf(20)).toBe(1)
	})
})
