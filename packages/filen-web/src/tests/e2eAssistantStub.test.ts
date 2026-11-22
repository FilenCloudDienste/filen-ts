import { describe, expect, it, vi } from "vitest"
import { formFillPrompt, speakerNotesPrompt, type AssistantGenerateRequest } from "@filen/shared/assistant"
import { assistantStubGenerate, assistantStubRequests, loadAssistantStubScript } from "@/e2e-hooks/assistantStubModel"

// The e2e suite's scripted model (e2e-hooks/assistantStubModel.ts): each request kind answers from its part of the script,
// and a "{{handle:NAME}}" argument takes the handle the request shows for NAME.
const TOOL = {
	name: "rename_by_pattern",
	description: "",
	parameters: { type: "object" as const, properties: {}, required: [], additionalProperties: false as const }
}

function generate(request: AssistantGenerateRequest) {
	return assistantStubGenerate(request, { signal: new AbortController().signal })
}

function main(content: string, extra: Partial<AssistantGenerateRequest> = {}): AssistantGenerateRequest {
	return {
		messages: [
			{ role: "system", content: "You are the assistant" },
			{ role: "user", content }
		],
		tools: [TOOL],
		slot: "main",
		maxTokens: 64,
		...extra
	}
}

function single(
	slot: AssistantGenerateRequest["slot"],
	system: string,
	extra: Partial<AssistantGenerateRequest> = {}
): AssistantGenerateRequest {
	return { messages: [{ role: "system", content: system }], slot, maxTokens: 8, ...extra }
}

describe("assistant e2e stub", () => {
	it("answers each request kind from its part of the script", async () => {
		const before = assistantStubRequests().length

		loadAssistantStubScript({
			route: "batch change",
			reply: "Renamed.",
			transform: "Shorter.",
			formula: "=SUM(A1:A2)",
			draft: "On my way",
			extract: "Page one says hi."
		})

		expect((await generate(single("router", "Route", { grammar: "root ::= x" }))).content).toBe("batch change")
		expect((await generate(single("extraction", "Write a formula", { grammar: "root ::= x" }))).content).toBe("=SUM(A1:A2)")
		expect((await generate(single("extraction", "You edit text the user selected. Shorten it."))).content).toBe("Shorter.")
		expect((await generate(single("extraction", "Answer the user's request using only the data below"))).content).toBe(
			"Page one says hi."
		)
		expect((await generate(single("main", "Write a reply the user can send in a chat, based only on the summary"))).content).toBe(
			"On my way"
		)
		expect((await generate(main("x", { toolChoice: "none" }))).content).toBe("Renamed.")
		expect((await generate(main("x"))).content).toBe("Renamed.")
		expect(
			assistantStubRequests()
				.slice(before)
				.map(request => request.kind)
		).toEqual(["router", "formula", "transform", "extract", "draft", "reply", "step"])
	})

	it("drafts speaker notes and fills a form's fields by their labels, over the real prompts", async () => {
		const before = assistantStubRequests().length
		const notes = speakerNotesPrompt("⟦Q3 results⟧")
		const form = formFillPrompt(
			[
				{ id: 7, kind: "text", label: "Full name", options: [], editable: false, multiline: false, maxLength: 0 },
				{ id: 8, kind: "text", label: "City", options: [], editable: false, multiline: false, maxLength: 0 }
			],
			"Jane Doe from Berlin"
		)

		loadAssistantStubScript({ notes: "Revenue grew this quarter.", form: { City: "Berlin" } })

		const asked = (system: string, user: string, extra: Partial<AssistantGenerateRequest> = {}): AssistantGenerateRequest => ({
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user }
			],
			slot: "extraction",
			maxTokens: 8,
			...extra
		})

		expect((await generate(asked(notes.system, notes.user))).content).toBe("Revenue grew this quarter.")
		expect((await generate(asked(form.system, form.user, { grammar: "root ::= x" }))).content).toBe("2: Berlin\n")
		expect(
			assistantStubRequests()
				.slice(before)
				.map(request => request.kind)
		).toEqual(["notes", "form"])
	})

	it("plays its steps in order, resolving handles from the context line and rows, then replies", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined)

		loadAssistantStubScript({
			steps: [
				[{ name: "rename_by_pattern", args: { directory: "{{handle:Invoices}}", files: ["{{handle:a b.pdf}}"] } }],
				[{ name: "list_directory", args: { directory: "{{handle:Missing}}" } }]
			],
			reply: "All done."
		})

		const first = await generate(
			main('screen: drive, current directory: "/Work/Invoices" (handle d4), nothing selected, f7 ⟦a b.pdf⟧ size=1 KB')
		)

		expect(first.toolCalls.map(call => [call.name, JSON.parse(call.arguments) as unknown])).toEqual([
			["rename_by_pattern", { directory: "d4", files: ["f7"] }]
		])

		const second = await generate(main("nothing named here"))

		expect(JSON.parse(second.toolCalls[0]?.arguments ?? "") as unknown).toEqual({ directory: "{{handle:Missing}}" })
		expect(error).toHaveBeenCalledOnce()
		expect(await generate(main("x"))).toEqual({ content: "All done.", toolCalls: [] })

		error.mockRestore()
	})

	it("resolves a handle from a single-item result", async () => {
		loadAssistantStubScript({ steps: [[{ name: "get_item_info", args: { item: "{{handle:CV.pdf}}" } }]] })

		const step = await generate(main('{"handle":"f3","name":"CV.pdf","size":"1 KB"}'))

		expect(JSON.parse(step.toolCalls[0]?.arguments ?? "") as unknown).toEqual({ item: "f3" })
	})
})
