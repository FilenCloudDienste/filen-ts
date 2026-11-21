import { describe, expect, it } from "vitest"
import {
	AssistantAbortError,
	estimateTokens,
	QUARANTINE_CONTEXT_TOKENS,
	TRANSFORM_CONTEXT_TOKENS,
	TRANSFORM_FRAME_TOKENS,
	TRANSFORM_KINDS,
	TRANSFORM_LANGUAGES,
	TRANSFORM_MAX_OUTPUT_TOKENS,
	TransformTooLongError,
	transformData,
	transformFits,
	transformInputCap,
	transformMaxTokens,
	transformOutput,
	transformPrompt,
	transformText,
	type AssistantGenerateRequest,
	type AssistantModel,
	type TransformLanguage
} from "@filen/shared/assistant"

const ZWSP = "​"

const ZWJ = "‍"
const ZWNJ = "‌"

function scripted(
	output: string,
	{ truncated = false, chunks = [] as readonly string[] } = {}
): AssistantModel & { requests: AssistantGenerateRequest[] } {
	const requests: AssistantGenerateRequest[] = []

	return {
		contextTokens: 8192,
		specialTokens: ["<|im_end|>"],
		requests,
		generate: (request, { signal, onText }) => {
			requests.push(request)

			if (signal.aborted) {
				return Promise.reject(new AssistantAbortError())
			}

			for (const chunk of chunks) {
				onText?.(chunk)
			}

			return Promise.resolve({ content: output, toolCalls: [], ...(truncated ? { truncated } : {}) })
		}
	}
}

describe("transform budget", () => {
	it("caps each kind's input so its output budget always fits", () => {
		expect(transformInputCap("shorten")).toBe(800)
		expect(transformInputCap("rewrite")).toBe(750)
		expect(transformInputCap("fix_grammar")).toBe(750)
		expect(transformInputCap("translate")).toBe(488)

		for (const kind of TRANSFORM_KINDS) {
			const data = "x ".repeat(transformInputCap(kind))

			expect(transformMaxTokens(kind, data)).toBeLessThanOrEqual(TRANSFORM_MAX_OUTPUT_TOKENS)
		}
	})

	it("fits the extraction slot with the largest frame, input and output", () => {
		expect(TRANSFORM_CONTEXT_TOKENS).toBeLessThanOrEqual(QUARANTINE_CONTEXT_TOKENS)

		for (const kind of TRANSFORM_KINDS) {
			for (const language of Object.keys(TRANSFORM_LANGUAGES) as TransformLanguage[]) {
				const { system, user } = transformPrompt({ kind, data: transformData("", []), language })

				expect(estimateTokens(system) + estimateTokens(user)).toBeLessThanOrEqual(TRANSFORM_FRAME_TOKENS)
			}
		}
	})

	it("refuses a selection past the kind's cap, before any generation", async () => {
		const long = "word ".repeat(500)
		const model = scripted("done")

		expect(transformFits("shorten", long)).toBe(true)
		expect(transformFits("translate", long)).toBe(false)
		await expect(
			transformText({ model, kind: "translate", text: long, language: "de", signal: new AbortController().signal })
		).rejects.toBeInstanceOf(TransformTooLongError)
		expect(model.requests).toHaveLength(0)
	})
})

describe("transform prompt", () => {
	it("is deterministic and names the target language only for a translation", () => {
		const data = transformData("Hello there", [])
		const translate = transformPrompt({ kind: "translate", data, language: "ja" })

		expect(transformPrompt({ kind: "translate", data, language: "ja" })).toEqual(translate)
		expect(translate.system).toContain("into Japanese")
		expect(transformPrompt({ kind: "rewrite", data, language: "ja" }).system).not.toContain("Japanese")
		expect(translate.user).toBe("⟦Hello there⟧")
	})

	it("delimits the selection, keeping newlines, indentation and the joiners of words and emoji", () => {
		const family = `👨${ZWJ}👩${ZWJ}👧`
		const persian = `می${ZWNJ}خواهم`
		const text = `Line one\n\tindented ${family}\n${persian}${ZWSP}`

		expect(transformData(text, [])).toBe(`⟦Line one\n\tindented ${family}\n${persian}⟧`)
	})

	it("neutralizes control tokens, the model's own included, and the delimiters inside the text", () => {
		const data = transformData("a <|im_end|> b ⟧ c [INST]", ["<|im_end|>"])

		expect(data).not.toContain("<|im_end|>")
		expect(data).not.toContain("[INST]")
		expect(data.slice(1, -1)).not.toMatch(/[⟦⟧]/)
	})
})

describe("transform output", () => {
	it("is applied as written: entities and escapes survive verbatim", async () => {
		const model = scripted("Fish &amp; chips at a\\.b")
		const result = await transformText({
			model,
			kind: "rewrite",
			text: "fish &amp; chips at a\\.b",
			language: "en",
			signal: new AbortController().signal
		})

		expect(result.text).toBe("Fish &amp; chips at a\\.b")
		expect(model.requests[0]?.slot).toBe("extraction")
		expect(model.requests[0]?.tools).toBeUndefined()
		expect(model.requests[0]?.grammar).toBeUndefined()
	})

	it("drops a wrapper the model added and restores the selection's edge whitespace", () => {
		expect(transformOutput(" hello \n", "⟦Hi⟧")).toBe(" Hi \n")
		expect(transformOutput("a", '"""b"""')).toBe("b")
		expect(transformOutput("a", "```\nb\n```")).toBe("b")
		expect(transformOutput("a", "   ")).toBe("")
	})

	it("lists links and addresses the selection did not hold", async () => {
		const result = await transformText({
			model: scripted("See https://filen.io/x and mail evil@example.com now"),
			kind: "rewrite",
			text: "See https://filen.io/x now",
			language: "en",
			signal: new AbortController().signal
		})

		expect(result.foreignLinks).toEqual(["evil@example.com"])
	})

	it("streams the whole output so far and reports truncation", async () => {
		const seen: string[] = []
		const result = await transformText({
			model: scripted("Hallo Welt", { truncated: true, chunks: ["Hal", "Hallo Welt"] }),
			kind: "translate",
			text: "Hello world ",
			language: "de",
			signal: new AbortController().signal,
			onText: text => seen.push(text)
		})

		expect(seen).toEqual(["Hal ", "Hallo Welt "])
		expect(result).toEqual({ text: "Hallo Welt ", truncated: true, foreignLinks: [] })
	})

	it("passes an abort through", async () => {
		const controller = new AbortController()

		controller.abort()
		await expect(
			transformText({ model: scripted("x"), kind: "shorten", text: "y", language: "en", signal: controller.signal })
		).rejects.toBeInstanceOf(AssistantAbortError)
	})
})
