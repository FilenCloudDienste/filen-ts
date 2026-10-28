import { describe, expect, it, vi } from "vitest"
import type { ConversionLossKind, ConversionReport, PortLike, PresentationSessionApi } from "@filen/office/dom/presentation"
import { savePortWriter, type SavePortEnd } from "@filen/office/dom/presentation/savePort"
import { i18n } from "@/lib/i18n"
import { conversionLossLines, joinFreshPackage, readFreshPackage } from "@/features/presentation/lib/presentationConvert"

// A converted deck's package read from the worker's save port as the chunks it came in, its refusal thrown, its read
// cancelled; and what the copy holds differently, in words for every loss kind the engine reports.

vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

// Every kind, once (a kind the engine adds fails the typecheck here until the test names it).
const KINDS: Readonly<Record<ConversionLossKind, true>> = {
	oleObject: true,
	media: true,
	animation: true,
	transition: true,
	comment: true,
	macros: true,
	action: true,
	wordArt: true,
	customGeometry: true,
	picture: true,
	slideColorScheme: true,
	patternFill: true,
	damagedContent: true,
	fill: true,
	line: true,
	geometry: true,
	text: true,
	tableStyle: true,
	chart: true,
	chartDetail: true,
	field: true,
	smartArt: true,
	threeD: true,
	ink: true,
	shape: true,
	background: true,
	slideSize: true,
	showSettings: true,
	signature: true,
	writeReservation: true
}

function report(losses: ConversionReport["losses"]): ConversionReport {
	return { target: "odp", bytes: 0, losses }
}

const words = (key: string, count: number): string => i18n.t(`preview:${key}` as never, { count })

describe("what a converted copy holds differently", () => {
	it("words every loss kind, counted where it is counted", () => {
		for (const kind of Object.keys(KINDS)) {
			const [one] = conversionLossLines(report([{ kind, count: 3 }]), words)

			expect(one, kind).toBeDefined()
			expect(one, kind).not.toMatch(/^preview/)
			expect(one, kind).not.toMatch(/\.pptx|\.odp/)
		}

		expect(conversionLossLines(report([{ kind: "chart", count: 1 }]), words)).toEqual(["1 chart, left out"])
		expect(conversionLossLines(report([{ kind: "chart", count: 2 }]), words)).toEqual(["2 charts, left out"])
	})

	it("keeps the report's order and leaves out a kind it has no words for", () => {
		expect(
			conversionLossLines(
				report([
					{ kind: "signature", count: 1 },
					{ kind: "fromANewerEngine", count: 4 },
					{ kind: "ink", count: 2 }
				]),
				words
			)
		).toEqual(["Its digital signature, which a new file can't keep", "2 ink drawings, left out"])
	})
})

function writing(
	chunks: readonly Uint8Array[] | Error,
	losses: ConversionReport["losses"] = []
): PresentationSessionApi & { aborted: Promise<string> } {
	const aborted = Promise.withResolvers<string>()

	return {
		aborted: aborted.promise,
		async freshParts(target: "pptx" | "odp", port: PortLike): Promise<ConversionReport> {
			if (chunks instanceof Error) throw chunks

			const writer = savePortWriter(port as SavePortEnd, { lingerMs: 10 })

			void writer.aborted.then(aborted.resolve)
			writer.announce()

			let bytes = 0

			for (const chunk of chunks) {
				await writer.write(chunk)
				bytes += chunk.length
			}

			await writer.close()
			writer.commit()

			return { target, bytes, losses }
		}
	} as unknown as PresentationSessionApi & { aborted: Promise<string> }
}

describe("readFreshPackage", () => {
	it("reads the package the session streams, with its report", async () => {
		const big = new Uint8Array(1024 * 1024 + 7).fill(5)
		const fresh = await readFreshPackage(writing([Uint8Array.of(1, 2), big]), "pptx")

		expect(fresh.size).toBe(big.length + 2)
		expect(fresh.report.target).toBe("pptx")

		const bytes = joinFreshPackage(fresh)

		expect([...bytes.subarray(0, 3)]).toEqual([1, 2, 5])
		expect(bytes.length).toBe(fresh.size)
	})

	it("throws the session's refusal, not the port's", async () => {
		const refusal = new Error("encrypted")

		await expect(readFreshPackage(writing(refusal), "odp")).rejects.toBe(refusal)
	})

	it("a cancel ends the read and the worker's writes", async () => {
		const controller = new AbortController()
		const deck = writing(Array.from({ length: 64 }, () => new Uint8Array(1024 * 1024)))
		const reading = readFreshPackage(deck, "odp", controller.signal)

		controller.abort()

		await expect(reading).rejects.toThrow()
		await expect(deck.aborted).resolves.toBe("cancelled")
	})
})
