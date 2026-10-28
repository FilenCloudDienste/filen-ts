import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { bytesSource } from "../core/opc/index"
import type { SlideRender, TextPage } from "../core/presentation/output"
import type { PlaceholderPrompts } from "../core/presentation/render/prompts"
import { blankOdp } from "../core/templates/odp"
import { blankPptx } from "../core/templates/pptx"
import { SERVICES, type CallContext, type EngineSession, type PresentationScheduler } from "../dom/presentation/engine"
import { openOdpCapability } from "../dom/presentation/engine/open/odp"
import { openPptxCapability } from "../dom/presentation/engine/open/pptx"
import { presentationTextServices, renderSlideFor, viewCapability } from "../dom/presentation/engine/view"
import type { PresentationEvent, PresentationOpenOptions } from "../dom/presentation/protocol"
import { installPresentationRealm } from "../dom/presentation/services"
import { streamOpenWindow } from "../dom/presentation/window"
import { HmtxMeasurer, nodeFontAssets } from "./layoutFixtures"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { budget, cpuMs } from "./timing"

// Empty placeholders show their prompt in the editor's renders only: render({ prompts }) of an editable deck whose
// open carries the strings (and the open window it streams). A plain render (print), renderSlideFor (thumbnails, the
// show's layers, exports) and a view-only open never carry one. The prompt is laid out as the placeholder's own text
// would be, or is the layout placeholder's text with hasCustomPrompt.

const PROMPTS: PlaceholderPrompts = {
	title: "Click to add title",
	subtitle: "Click to add subtitle",
	text: "Click to add text",
	picture: "Click to add picture",
	chart: "Click to add chart",
	table: "Click to add table",
	smartart: "Click to add SmartArt graphic",
	media: "Click to add media",
	clipArt: "Click to add clip art"
}

const SLICING = { pause: () => Promise.resolve(), sliceMs: 8, now: () => Date.now() }

// `withoutPrompts`: an open that carries no prompt strings.
async function contextOf(
	bytes: Uint8Array,
	format: "pptx" | "odp",
	extra: Partial<PresentationOpenOptions> = {},
	withoutPrompts = false
): Promise<CallContext> {
	const options: PresentationOpenOptions = withoutPrompts
		? { format, fileName: `deck.${format}`, ...extra }
		: { format, fileName: `deck.${format}`, prompts: PROMPTS, ...extra }
	const outcome = await (format === "pptx" ? openPptxCapability : openOdpCapability).open({
		source: bytesSource(bytes),
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

	return { session, signal: { aborted: false, onAbort: () => undefined }, lane: "priority", slicing: SLICING }
}

function firstSlide(context: CallContext) {
	const ref = context.session.deck.slides[0]

	if (ref === undefined) throw new Error("no slide")

	return ref
}

async function editorRender(context: CallContext): Promise<SlideRender> {
	const [render] = await viewCapability.render(context, [firstSlide(context)], { prompts: true })

	if (render === undefined) throw new Error("no render")

	return render
}

function prompts(render: SlideRender): string[] {
	return render.layers.flatMap(layer => (layer.prompt === undefined ? [] : [layer.prompt.page.sourceTexts.join("\n")]))
}

// A page's distinct text styles, the session's own face-name prefix left out.
function stylesOf(page: TextPage | undefined): string[] {
	return [...new Set((page?.styles ?? []).map(style => JSON.stringify(style).replace(/"fo[0-9a-f]+-/gu, '"fo-')))]
}

beforeAll(() => {
	installPresentationRealm({
		text: {
			fontHost: { addBytes: () => Promise.resolve(true), addLocal: () => Promise.resolve(false), remove: () => undefined },
			replayFonts: true,
			fontAssets: nodeFontAssets,
			measurer: new HmtxMeasurer(),
			yield: () => Promise.resolve()
		},
		canvas: {
			canvas: () => undefined,
			decode: () => Promise.resolve(undefined),
			copy: () => Promise.resolve(undefined),
			fontsReady: () => Promise.resolve()
		}
	})
})

afterAll(() => {
	installPresentationRealm(undefined)
})

describe("empty placeholder prompts", () => {
	it("shows a blank pptx's title and subtitle prompts in the editor's render, in the style typed text gets", async () => {
		const context = await contextOf(await blankPptx(), "pptx")
		const render = await editorRender(context)

		expect(prompts(render)).toEqual([PROMPTS.title, PROMPTS.subtitle])
		// A prompt is no text of the slide's.
		expect(render.layers.filter(layer => layer.prompt !== undefined && layer.text !== undefined)).toEqual([])

		// The same words typed into the title lay out identically: same styles (face, size, colour), same positions.
		const typed = await editorRender(await contextOf(await blankPptx({ title: PROMPTS.title }), "pptx"))
		const promptLayer = render.layers.find(layer => layer.prompt !== undefined)
		const titleLayer = typed.layers.find(layer => layer.text !== undefined)

		expect(stylesOf(promptLayer?.prompt)).toEqual(stylesOf(titleLayer?.text))
		expect([...(promptLayer?.prompt?.page.fragmentFloats ?? [])]).toEqual([...(titleLayer?.text?.page.fragmentFloats ?? [])])
		expect(promptLayer?.textMatrix).toEqual(titleLayer?.textMatrix)
		// The typed title has no prompt; the still empty subtitle keeps its own.
		expect(prompts(typed)).toEqual([PROMPTS.subtitle])
	})

	it("never carries a prompt without the option, in a slide render for thumbnails and exports, or in a view-only open", async () => {
		const bytes = await blankPptx()
		const context = await contextOf(bytes, "pptx")
		const ref = firstSlide(context)
		const [plain] = await viewCapability.render(context, [ref])
		const thumb = await renderSlideFor(context, ref)
		const viewOnly = await editorRender(await contextOf(bytes, "pptx", { viewOnly: true }))
		const noStrings = await editorRender(await contextOf(bytes, "pptx", {}, true))

		for (const render of [plain, thumb, viewOnly, noStrings]) expect(render === undefined ? ["missing"] : prompts(render)).toEqual([])
	})

	it("shows the layout placeholder's own text for a placeholder with hasCustomPrompt, on the slide or the layout", async () => {
		const layout = {
			name: "Custom",
			type: "obj",
			shapes:
				sp(2, "Title 1", 'type="title"', "", body(para("Name of the speaker"))) +
				sp(3, "Content 2", 'idx="1"', xfrm(150, 750, 2900, 1900), body(para("Master text styles"))) +
				sp(4, "Speaker 3", 'type="body" idx="13" hasCustomPrompt="1"', xfrm(150, 2700, 2900, 300), body(para("Speaker name")))
		}
		const bytes = buildPptx({
			layouts: [layout],
			slides: [
				{
					layout: 1,
					shapes:
						sp(2, "Title 1", 'type="title" hasCustomPrompt="1"', "", body("<a:p><a:endParaRPr/></a:p>")) +
						sp(3, "Content 2", 'idx="1"', "", body("<a:p><a:endParaRPr/></a:p>")) +
						sp(4, "Speaker 3", 'type="body" idx="13"', "", body("<a:p><a:endParaRPr/></a:p>"))
				}
			]
		})

		expect(prompts(await editorRender(await contextOf(bytes, "pptx")))).toEqual([
			"Name of the speaker",
			// A layout placeholder's text without the flag is no prompt; the body's bullet shows, as in PowerPoint.
			`•\t${PROMPTS.text}`,
			// The flag on the layout's placeholder, where PowerPoint writes it.
			"•\tSpeaker name"
		])
	})

	it("shows a blank odp's empty presentation objects' prompts by class, in the style typed text gets", async () => {
		const render = await editorRender(await contextOf(await blankOdp({ locale: "en-US" }), "odp"))

		expect(prompts(render)).toEqual([PROMPTS.title, PROMPTS.subtitle])

		// The empty frame's presentation style (the title page's 60 pt, centred) holds for its prompt as for a title.
		const typed = await editorRender(await contextOf(await blankOdp({ locale: "en-US", title: PROMPTS.title }), "odp"))
		const promptLayer = render.layers.find(layer => layer.prompt !== undefined)
		const titleLayer = typed.layers.find(layer => layer.text !== undefined)

		expect(stylesOf(promptLayer?.prompt)).toEqual(stylesOf(titleLayer?.text))
		expect([...(promptLayer?.prompt?.page.fragmentFloats ?? [])]).toEqual([...(titleLayer?.text?.page.fragmentFloats ?? [])])
		expect(prompts(typed)).toEqual([PROMPTS.subtitle])
	})

	it("streams the open window with the editor's prompts", async () => {
		const context = await contextOf(await blankPptx(), "pptx")
		const events: PresentationEvent[] = []
		const session: EngineSession = { ...context.session, emit: event => events.push(event) }
		let task: Promise<void> | undefined
		const scheduler: PresentationScheduler = {
			slicing: () => SLICING,
			schedule: (_lane, run, signal) => {
				task = run(SLICING, signal)
			}
		}

		streamOpenWindow(session, { from: 0, count: 1 }, viewCapability.render, scheduler, context.signal)
		await task

		const slides = events.find(event => event.type === "slides")

		expect(slides?.type === "slides" ? slides.renders.flatMap(prompts) : []).toEqual([PROMPTS.title, PROMPTS.subtitle])
	})

	it("costs little over a render without prompts", async () => {
		const context = await contextOf(await blankPptx(), "pptx")
		const ref = firstSlide(context)
		const time = async (options: { prompts: boolean } | undefined): Promise<number> => {
			let least = Number.POSITIVE_INFINITY

			for (let run = 0; run < 7; run++) {
				const start = cpuMs()

				for (let k = 0; k < 20; k++) await viewCapability.render(context, [ref], options)

				least = Math.min(least, (cpuMs() - start) / 20)
			}

			return least
		}

		await time({ prompts: true })

		const off = await time(undefined)
		const on = await time({ prompts: true })

		// Two short bodies laid out on top of the slide's render.
		expect(on).toBeLessThan(off + budget(3))
	}, 60_000)
})
