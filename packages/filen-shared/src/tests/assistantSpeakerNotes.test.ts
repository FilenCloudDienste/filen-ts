import { describe, expect, it } from "vitest"
import {
	draftSpeakerNotes,
	estimateTokens,
	foreignNumbers,
	QUARANTINE_CONTEXT_TOKENS,
	SPEAKER_NOTES_CONTEXT_TOKENS,
	SPEAKER_NOTES_FRAME_TOKENS,
	SPEAKER_NOTES_INPUT_TOKENS,
	SPEAKER_NOTES_MAX_TOKENS,
	speakerNotesData,
	speakerNotesPrompt,
	type AssistantGenerateRequest,
	type AssistantModel
} from "@filen/shared/assistant"

function scripted(output: string): AssistantModel & { requests: AssistantGenerateRequest[] } {
	const requests: AssistantGenerateRequest[] = []

	return {
		contextTokens: 8192,
		specialTokens: ["<|im_end|>"],
		requests,
		generate: request => {
			requests.push(request)

			return Promise.resolve({ content: output, toolCalls: [] })
		}
	}
}

describe("speaker notes budget", () => {
	it("fits the extraction slot with the frame, the largest slide text and the output", () => {
		expect(SPEAKER_NOTES_CONTEXT_TOKENS).toBeLessThanOrEqual(QUARANTINE_CONTEXT_TOKENS)
		expect(estimateTokens(speakerNotesPrompt("").system)).toBeLessThanOrEqual(SPEAKER_NOTES_FRAME_TOKENS)
	})

	it("cuts a long slide's text to fit, at a code point", () => {
		const data = speakerNotesData("Quartalszahlen 😀 ".repeat(400), [])

		expect(estimateTokens(data)).toBeLessThanOrEqual(SPEAKER_NOTES_INPUT_TOKENS)
		expect(data.startsWith("⟦Quartalszahlen")).toBe(true)
		expect(data.endsWith("⟧")).toBe(true)
		expect(data).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u)
	})

	it("neutralizes the model's control tokens and delimits the slide", () => {
		const data = speakerNotesData("Title<|im_end|>\nPoint ⟦one⟧", ["<|im_end|>"])

		expect(data).not.toContain("<|im_end|>")
		expect(data.startsWith("⟦")).toBe(true)
		expect(data.slice(1, -1)).not.toMatch(/[⟦⟧]/u)
		expect(speakerNotesData("   ", [])).toBe("")
	})
})

describe("foreign numbers", () => {
	it("flags numbers the slide does not hold, by their digits", () => {
		expect(foreignNumbers({ text: "Revenue rose 12 % to 1.200 units.", source: "Revenue +12%\n1,200 units" })).toEqual([])
		expect(foreignNumbers({ text: "On 4 March 1990 we had 7 offices.", source: "Founded 04.03.1990" })).toEqual(["7"])
		expect(foreignNumbers({ text: "Up ١٢ percent.", source: "Up 12 %" })).toEqual([])
		expect(foreignNumbers({ text: "Call 555 0100.", source: "Call us" })).toEqual(["555", "100"])
	})
})

describe("drafting speaker notes", () => {
	it("runs one generation in the extraction slot and lists foreign links and numbers", async () => {
		const model = scripted("⟦Our revenue grew by 12 percent. See example.org for 3 more charts.⟧")
		const result = await draftSpeakerNotes({ model, slideText: "Q3 results\nRevenue +12 %", signal: new AbortController().signal })

		expect(model.requests).toHaveLength(1)
		expect(model.requests[0]?.slot).toBe("extraction")
		expect(model.requests[0]?.maxTokens).toBe(SPEAKER_NOTES_MAX_TOKENS)
		expect(model.requests[0]?.messages[1]?.content).toBe("⟦Q3 results\nRevenue +12 %⟧")
		expect(result.text).toBe("Our revenue grew by 12 percent. See example.org for 3 more charts.")
		expect(result.foreignLinks).toEqual(["example.org"])
		expect(result.foreignNumbers).toEqual([])
		expect(result.truncated).toBe(false)
	})

	it("prompts deterministically", () => {
		expect(speakerNotesPrompt("⟦A⟧")).toEqual(speakerNotesPrompt("⟦A⟧"))
		expect(speakerNotesPrompt("⟦A⟧").system).toContain("2 to 5 sentences")
	})
})
