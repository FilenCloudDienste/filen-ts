import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import type { CallContext, EngineSession } from "../dom/presentation/engine"
import { openOdpCapability } from "../dom/presentation/engine/open/odp"
import { viewCapability } from "../dom/presentation/engine/view"
import type { PresentationEvent } from "../dom/presentation/protocol"
import { odpBytes, page } from "./odpFixtures"

// An ODP deck through the view capability, as the viewer, the rail and the jobs worker reach it: its slides render
// from the ODP reader's parts (no pptx parts), and its pictures are served by image().

const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15,
	0xc4, 0x89
])

async function opened(): Promise<{ readonly context: CallContext; close(): void }> {
	const bytes = odpBytes({
		extra: [{ name: "Pictures/a.png", data: PNG, mediaType: "image/png" }],
		automatic:
			'<style:style style:name="g1" style:family="graphic"><style:graphic-properties draw:fill="solid" draw:fill-color="#336699"/></style:style>',
		body: page(
			'<draw:rect draw:style-name="g1" svg:x="1cm" svg:y="1cm" svg:width="4cm" svg:height="2cm"><text:p>Text</text:p></draw:rect>' +
				'<draw:frame svg:x="6cm" svg:y="1cm" svg:width="4cm" svg:height="3cm"><draw:image xlink:href="Pictures/a.png"/></draw:frame>'
		)
	})
	const source = bytesSource(bytes)
	const outcome = await openOdpCapability.open({ source, sourceKind: "bytes", options: { format: "odp" } as never })

	if (outcome.kind !== "opened") throw new Error(outcome.kind)

	const closers: (() => void)[] = []
	const session = {
		s: 1,
		deck: outcome.deck,
		package: outcome.package,
		emit: (_event: PresentationEvent) => undefined,
		onClose: (listener: () => void) => closers.push(listener)
	} as unknown as EngineSession
	const context: CallContext = {
		session,
		signal: { aborted: false, onAbort: () => undefined },
		lane: "priority",
		slicing: { pause: () => Promise.resolve(), sliceMs: 1e9, now: () => 0 }
	}

	return { context, close: () => closers.forEach(close => close()) }
}

describe("ODP through the view capability", () => {
	it("renders an ODP slide from the ODP reader's parts", async () => {
		const { context, close } = await opened()
		const [render] = await viewCapability.render(context, [context.session.deck.slides[0] ?? (0 as never)])

		expect(render?.layers.map(layer => layer.role)).toEqual(["shape", "picture"])
		expect(render?.background.width).toBeGreaterThan(0)
		close()
	})

	it("serves an ODP picture's bytes to the page", async () => {
		const { context, close } = await opened()

		expect(await viewCapability.image(context, "/Pictures/a.png")).toEqual({ bytes: PNG, type: "image/png" })
		expect(await viewCapability.image(context, "/Pictures/missing.png")).toBeNull()
		close()
	})
})
