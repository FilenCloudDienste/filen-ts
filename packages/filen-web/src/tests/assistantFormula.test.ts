import { describe, expect, it, vi } from "vitest"
import { CellFlag, EN_US_LOCALE, type SheetLocale } from "@filen/office/core/sheet"
import { FORMULA_GRAMMAR, type AssistantGenerateRequest, type AssistantModel, type FormulaContext } from "@filen/shared/assistant"
import { createAssistantFormulaWriter } from "@/features/assistant/transform/formula"
import type { AssistantFormulaRequest, AssistantFormulaValue, AssistantModelState } from "@/features/assistant/types"
import {
	formulaCellType,
	formulaChecker,
	formulaColumns,
	localizedEntry,
	type FormulaTarget
} from "@/features/spreadsheet/formulaBar/assistantFormula"

const MODEL = { id: "m", name: "Model", sizeBytes: 1 }

const DE: SheetLocale = { decimal: ",", group: ".", argument: ";", dateOrder: "dmy" }

const VALUE: AssistantFormulaValue = { value: 15, error: false, rows: 1, cols: 1 }

// A runtime whose model answers each generation with the next of `outputs` once `finish` is called.
function fakeRuntime(initial: "ready" | "downloaded" = "ready") {
	let state: AssistantModelState =
		initial === "ready" ? { kind: "ready", model: MODEL } : { kind: "downloaded", model: MODEL, idleUnloaded: false }
	const requests: AssistantGenerateRequest[] = []
	const holds = { taken: 0, released: 0 }
	let pending: ((content: string) => void) | null = null
	const model: AssistantModel = {
		contextTokens: 8192,
		specialTokens: [],
		generate: (request, { signal }) => {
			requests.push(request)

			return new Promise((resolve, reject) => {
				pending = content => {
					resolve({ content, toolCalls: [] })
				}
				;(signal as AbortSignal).addEventListener("abort", () => {
					reject(new DOMException("aborted", "AbortError"))
				})
			})
		}
	}
	const runtime = {
		model,
		getState: () => state,
		load: vi.fn(() => {
			state = { kind: "ready", model: MODEL }

			return Promise.resolve()
		}),
		hold: () => {
			holds.taken++

			return () => {
				holds.released++
			}
		}
	}

	return {
		runtime,
		requests,
		holds,
		finish: async (content: string) => {
			await settle()
			pending?.(content)
		}
	}
}

const CONTEXT: FormulaContext = {
	sheet: "Sales",
	range: "A1:B4",
	headerRow: 1,
	cell: "B5",
	columns: [],
	ask: "total"
}

function request(overrides: Partial<AssistantFormulaRequest> = {}): AssistantFormulaRequest {
	return {
		context: CONTEXT,
		check: () => Promise.resolve({ ok: true, value: VALUE }),
		signal: new AbortController().signal,
		...overrides
	}
}

async function settle(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 0))
}

describe("createAssistantFormulaWriter", () => {
	it("loads a model on disk, writes under the grammar and returns the checked formula", async () => {
		const fake = fakeRuntime("downloaded")
		const running = createAssistantFormulaWriter(fake.runtime).run(request())

		await fake.finish("=SUM(B2:B4)")

		await expect(running).resolves.toEqual({ ok: true, formula: "=SUM(B2:B4)", value: VALUE })
		expect(fake.runtime.load).toHaveBeenCalledTimes(1)
		expect(fake.requests[0]).toMatchObject({ grammar: FORMULA_GRAMMAR, slot: "extraction" })
		expect(fake.holds).toEqual({ taken: 1, released: 1 })
	})

	it("is invalid after the second refusal", async () => {
		const fake = fakeRuntime()
		const running = createAssistantFormulaWriter(fake.runtime).run(
			request({ check: () => Promise.resolve({ ok: false, problem: { kind: "circular" } }) })
		)

		await fake.finish("=SUM(B:B)")
		await fake.finish("=SUM(B:B)")

		await expect(running).resolves.toEqual({ ok: false, error: "invalid" })
		expect(fake.requests).toHaveLength(2)
	})

	it("is cancelled by its signal, by a newer request and by signing out", async () => {
		const fake = fakeRuntime()
		const writer = createAssistantFormulaWriter(fake.runtime)
		const controller = new AbortController()
		const first = writer.run(request({ signal: controller.signal }))

		await settle()
		controller.abort()
		await expect(first).resolves.toEqual({ ok: false, error: "cancelled" })

		const second = writer.run(request())

		await settle()

		const third = writer.run(request())

		await expect(second).resolves.toEqual({ ok: false, error: "cancelled" })
		await settle()
		writer.shutdown()
		await expect(third).resolves.toEqual({ ok: false, error: "cancelled" })
		await expect(writer.run(request())).resolves.toEqual({ ok: false, error: "cancelled" })
		expect(fake.holds.taken).toBe(fake.holds.released)
	})
})

describe("the sheet's side of the formula helper", () => {
	it("reads cell kinds from the shown text, the held tile's flags first", () => {
		expect(formulaCellType("", EN_US_LOCALE)).toBe("empty")
		expect(formulaCellType("12.5", EN_US_LOCALE)).toBe("number")
		expect(formulaCellType("12,5", DE)).toBe("number")
		expect(formulaCellType("TRUE", EN_US_LOCALE)).toBe("logical")
		expect(formulaCellType("#DIV/0!", EN_US_LOCALE)).toBe("error")
		expect(formulaCellType("north", EN_US_LOCALE)).toBe("text")
		// A number shown in a format that does not read back as one.
		expect(formulaCellType("12 pcs", EN_US_LOCALE, CellFlag.NUMBER)).toBe("number")
		expect(formulaCellType("12 pcs", EN_US_LOCALE)).toBe("text")
	})

	it("describes the columns with the header row Excel would guess, and three data rows' kinds", () => {
		const range = { startRow: 0, startCol: 0, endRow: 9, endCol: 1 }
		const rows = [
			["Region", "Amount"],
			["north", "10"],
			["south", ""],
			["north", "5"]
		]

		expect(formulaColumns(range, rows, EN_US_LOCALE)).toEqual({
			header: true,
			columns: [
				{ column: "A", header: "Region", types: ["text", "text", "text"] },
				{ column: "B", header: "Amount", types: ["number", "empty", "number"] }
			]
		})
		expect(formulaColumns(range, rows.slice(1), EN_US_LOCALE)).toEqual({
			header: false,
			columns: [
				{ column: "A", header: null, types: ["text", "text", "text"] },
				{ column: "B", header: null, types: ["number", "empty", "number"] }
			]
		})
	})

	it("caps the columns described", () => {
		const range = { startRow: 0, startCol: 0, endRow: 1, endCol: 99 }

		expect(formulaColumns(range, [], EN_US_LOCALE).columns).toHaveLength(26)
	})

	it("checks before it asks the engine, and reads #NAME? as a refusal", async () => {
		const target: FormulaTarget = { sheet: 0, sheetName: "Sales", sheets: ["Sales"], row: 4, col: 1 }
		const answers: unknown[] = [
			{ value: 15, error: false, rows: 1, cols: 1 },
			{ value: "#NAME?", error: true, rows: 1, cols: 1 },
			{ refused: "formula" }
		]
		const query = vi.fn(() => Promise.resolve(answers.shift()))
		const check = formulaChecker({ session: { query } } as unknown as Parameters<typeof formulaChecker>[0], target)

		await expect(check('=HYPERLINK("https://example.com")')).resolves.toEqual({
			ok: false,
			problem: { kind: "function", name: "HYPERLINK", refused: true }
		})
		await expect(check("=SUM(B:B)")).resolves.toEqual({ ok: false, problem: { kind: "circular" } })
		expect(query).not.toHaveBeenCalled()

		await expect(check("=SUM(B2:B4)")).resolves.toEqual({ ok: true, value: VALUE })
		expect(query).toHaveBeenCalledWith("formulaPreview", { sheet: 0, formula: "=SUM(B2:B4)" })
		await expect(check("=SUM(Rate)")).resolves.toEqual({ ok: false, problem: { kind: "name" } })
		await expect(check("=SUM(B2:B4)")).resolves.toEqual({ ok: false, problem: { kind: "engine" } })
	})

	it("inserts the formula in the regional format's syntax", () => {
		expect(localizedEntry('=SUMIF(A2:A4,"north",B2:B4)*1.5', DE)).toBe('=SUMIF(A2:A4;"north";B2:B4)*1,5')
		expect(localizedEntry("=SUM(B2:B4)", EN_US_LOCALE)).toBe("=SUM(B2:B4)")
	})
})
