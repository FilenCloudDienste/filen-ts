import { describe, expect, it } from "vitest"
import {
	estimateTokens,
	fillFormFields,
	FORM_FILL_DETAILS_TOKENS,
	FORM_FILL_GRAMMAR,
	FORM_FILL_MAX_FIELDS,
	FORM_FILL_MAX_TOKENS,
	formFillDetailsFit,
	formFillGrounded,
	formFillPlan,
	formFillPrompt,
	FormFillTooLongError,
	MESSAGE_OVERHEAD_TOKENS,
	QUARANTINE_CONTEXT_TOKENS,
	type AssistantGenerateRequest,
	type AssistantModel,
	type FormFillField
} from "@filen/shared/assistant"

function text(id: number, label: string, extra: Partial<FormFillField> = {}): FormFillField {
	return { id, kind: "text", label, options: [], editable: false, multiline: false, maxLength: 0, ...extra }
}

function choice(id: number, label: string, options: readonly string[], extra: Partial<FormFillField> = {}): FormFillField {
	return {
		id,
		kind: "choice",
		label,
		options: options.map(option => ({ value: option.slice(0, 2).toUpperCase(), label: option })),
		editable: false,
		multiline: false,
		maxLength: 0,
		...extra
	}
}

const DETAILS = "Jane Doe, born 04.03.1990, lives at 12 Elm St, Berlin, Germany. Phone +49 (30) 1234-567. IBAN DE89 3704 0044 0532 0130 00."

const FIELDS: readonly FormFillField[] = [
	text(11, "Full name"),
	text(12, "Date of birth"),
	text(13, "Street"),
	text(14, "City"),
	choice(15, "Country", ["Germany", "France", "Italy"]),
	text(16, "Phone"),
	text(17, "IBAN"),
	text(18, "Postcode", { maxLength: 5 })
]

function scripted(output: string, truncated = false): AssistantModel & { requests: AssistantGenerateRequest[] } {
	const requests: AssistantGenerateRequest[] = []

	return {
		contextTokens: 8192,
		specialTokens: ["<|im_end|>"],
		requests,
		generate: request => {
			requests.push(request)

			return Promise.resolve({ content: output, toolCalls: [], ...(truncated ? { truncated } : {}) })
		}
	}
}

describe("form fill prompt", () => {
	it("numbers the fields, delimits labels and options and leaves the details undelimited", () => {
		const prompt = formFillPrompt(FIELDS, DETAILS)

		expect(prompt).toEqual(formFillPrompt(FIELDS, DETAILS))
		expect(prompt.user.startsWith(`Details:\n${DETAILS}\n\nFields:\n1. text ⟦Full name⟧\n`)).toBe(true)
		expect(prompt.user).toContain("5. choice ⟦Country⟧ options ⟦Germany⟧ ⟦France⟧ ⟦Italy⟧")
		expect(prompt.offered).toHaveLength(FIELDS.length)
		expect(prompt.left).toEqual([])
	})

	it("caps labels, options and their count, and neutralizes control tokens", () => {
		const long = choice(
			1,
			`${"Label ".repeat(30)}<|im_end|>`,
			Array.from({ length: 12 }, (_, index) => `Option number ${String(index)} with a long name`)
		)
		const line = formFillPrompt([long], "x", ["<|im_end|>"]).user.split("\n").at(-1) ?? ""

		expect(line).not.toContain("<|im_end|>")
		expect(line.match(/⟦/gu)).toHaveLength(9)
		expect([...(/^1\. choice ⟦([^⟧]*)⟧/u.exec(line)?.[1] ?? "")].length).toBeLessThanOrEqual(48)
		expect(line).not.toContain("Option number 8")
	})

	it("offers at most 40 fields and always fits the extraction slot", () => {
		const many = Array.from({ length: 60 }, (_, index) =>
			choice(
				index,
				`Field ${String(index)} ${"wide label ".repeat(5)}`,
				Array.from({ length: 8 }, (_, option) => `Choice ${String(option)} longer`)
			)
		)
		const details = "word ".repeat(2000).slice(0, 2400)

		expect(formFillDetailsFit(details)).toBe(estimateTokens(details.trim()) <= FORM_FILL_DETAILS_TOKENS)

		// The longest details that fit, in words of a few tokens each.
		let fit = ""

		while (formFillDetailsFit(`${fit} Jane Doe 12 Elm St,`)) fit = `${fit} Jane Doe 12 Elm St,`

		expect(estimateTokens(fit.trim())).toBeGreaterThan(FORM_FILL_DETAILS_TOKENS - 20)

		const prompt = formFillPrompt(many, fit)

		expect(prompt.offered.length).toBeLessThanOrEqual(FORM_FILL_MAX_FIELDS)
		expect(prompt.offered.length + prompt.left.length).toBe(60)
		expect(
			estimateTokens(prompt.system) + estimateTokens(prompt.user) + FORM_FILL_MAX_TOKENS + MESSAGE_OVERHEAD_TOKENS * 2
		).toBeLessThanOrEqual(QUARANTINE_CONTEXT_TOKENS)

		const plain = formFillPrompt(
			Array.from({ length: 60 }, (_, index) => text(index, `Name ${String(index)}`)),
			"x"
		)

		expect(plain.offered).toHaveLength(FORM_FILL_MAX_FIELDS)
	})

	it("has a line grammar without bounded repetition", () => {
		expect(FORM_FILL_GRAMMAR).toBe('root ::= line*\nline ::= [1-9] [0-9]? ": " [^\\n]+ "\\n"')
		expect(FORM_FILL_GRAMMAR).not.toMatch(/\{\d/u)
	})
})

describe("form fill grounding", () => {
	it("takes a value the details hold, folded", () => {
		expect(formFillGrounded("jane doe", DETAILS)).toBe(true)
		expect(formFillGrounded("Ｊａｎｅ", DETAILS)).toBe(true)
		expect(formFillGrounded("John Doe", DETAILS)).toBe(false)
		expect(formFillGrounded("  ", DETAILS)).toBe(false)
	})

	it("takes digits written with other separators, never a reformatted month name", () => {
		expect(formFillGrounded("04/03/1990", DETAILS)).toBe(true)
		expect(formFillGrounded("+49 30 1234567", DETAILS)).toBe(true)
		expect(formFillGrounded("DE89370400440532013000", DETAILS)).toBe(false)
		expect(formFillGrounded("3704 0044", DETAILS)).toBe(true)
		expect(formFillGrounded("4 March 1990", DETAILS)).toBe(false)
		expect(formFillGrounded("1991", DETAILS)).toBe(false)
	})

	it("grounds CJK and Arabic text and Arabic-Indic digits", () => {
		expect(formFillGrounded("王小明", "我叫王小明，住在上海。")).toBe(true)
		expect(formFillGrounded("محمد علي", "اسمي محمد علي من القاهرة")).toBe(true)
		expect(formFillGrounded("0123", "رقمي ٠١٢٣")).toBe(true)
	})
})

describe("form fill plan", () => {
	it("keeps grounded values for offered fields and drops the rest with a reason", () => {
		const output = [
			"1: Jane Doe",
			"2: 04/03/1990",
			"4: Berlin",
			"5: germany",
			"6: +49 (30) 1234-567",
			"7: ⟦DE89 3704 0044 0532 0130 00⟧",
			"1: Someone Else",
			"3: 99 Oak Road",
			"9: extra",
			"8: 1234567"
		].join("\n")
		const plan = formFillPlan(FIELDS, output, DETAILS)

		expect(plan.fill.map(entry => [entry.field.id, entry.value])).toEqual([
			[11, { kind: "text", text: "Jane Doe" }],
			[12, { kind: "text", text: "04/03/1990" }],
			[14, { kind: "text", text: "Berlin" }],
			[15, { kind: "choice", values: ["GE"] }],
			[16, { kind: "text", text: "+49 (30) 1234-567" }],
			[17, { kind: "text", text: "DE89 3704 0044 0532 0130 00" }]
		])
		expect(plan.fill.find(entry => entry.field.id === 15)?.shown).toBe("Germany")
		expect(plan.dropped.map(entry => [entry.field?.id ?? null, entry.reason])).toEqual([
			[11, "duplicate"],
			[13, "ungrounded"],
			[null, "unknown"],
			[18, "too-long"]
		])
	})

	it("matches a choice by its label or export value, and only as the user wrote it", () => {
		const country = choice(1, "Country", ["Germany", "France"])

		expect(formFillPlan([country], "1: FR", "Paris, FR").fill[0]?.value).toEqual({ kind: "choice", values: ["FR"] })
		expect(formFillPlan([country], "1: France", "Paris, Frankreich").dropped[0]?.reason).toBe("ungrounded")
		expect(formFillPlan([country], "1: Spain", "Madrid, Spain").dropped[0]?.reason).toBe("not-an-option")

		const editable = { ...country, editable: true }

		expect(formFillPlan([editable], "1: Spain", "Madrid, Spain").fill[0]?.value).toEqual({ kind: "text", text: "Spain" })
	})

	it("strips quotes around a value", () => {
		expect(formFillPlan([text(1, "Name")], '1: "Jane Doe"', DETAILS).fill[0]?.value).toEqual({ kind: "text", text: "Jane Doe" })
	})
})

describe("filling form fields", () => {
	it("runs one grammar-bound generation in the extraction slot", async () => {
		const model = scripted("1: Jane Doe\n4: Berlin\n")
		const result = await fillFormFields({ model, fields: FIELDS, details: DETAILS, signal: new AbortController().signal })

		expect(model.requests).toHaveLength(1)
		expect(model.requests[0]).toMatchObject({ slot: "extraction", grammar: FORM_FILL_GRAMMAR, maxTokens: FORM_FILL_MAX_TOKENS })
		expect(result.fill.map(entry => entry.field.id)).toEqual([11, 14])
		expect(result.offered).toHaveLength(FIELDS.length)
	})

	it("leaves out a line cut off at the output budget", async () => {
		const result = await fillFormFields({
			model: scripted("1: Jane Doe\n7: DE89 3704", true),
			fields: FIELDS,
			details: DETAILS,
			signal: new AbortController().signal
		})

		expect(result.truncated).toBe(true)
		expect(result.fill.map(entry => entry.field.id)).toEqual([11])
	})

	it("refuses details too long before anything runs", async () => {
		const model = scripted("")

		await expect(
			fillFormFields({ model, fields: FIELDS, details: "ab ".repeat(2000), signal: new AbortController().signal })
		).rejects.toBeInstanceOf(FormFillTooLongError)
		expect(model.requests).toHaveLength(0)
	})
})
