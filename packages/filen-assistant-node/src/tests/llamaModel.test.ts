import { describe, expect, it } from "vitest"
import { qwen35ChatWrapper, toHistory } from "../llamaModel"

// The mapping that needs no model: the loop's messages as node-llama-cpp's history, and the Qwen3.5 wrapper.

describe("toHistory", () => {
	it("puts each tool result onto the call it answers, inside the model turn that made it", () => {
		expect(
			toHistory(
				[
					{ role: "system", content: "s" },
					{ role: "user", content: "list" },
					{
						role: "assistant",
						content: "",
						toolCalls: [
							{ id: "a", name: "list_directory", arguments: JSON.stringify({ path: "/" }) },
							{ id: "b", name: "get_context", arguments: "not json" }
						]
					},
					{ role: "tool", toolCallId: "b", content: "plain" },
					{ role: "tool", toolCallId: "a", content: JSON.stringify({ items: [] }) },
					{ role: "tool", toolCallId: "unknown", content: "dropped" }
				],
				true
			)
		).toEqual([
			{ type: "system", text: "s" },
			{ type: "user", text: "list" },
			{
				type: "model",
				response: [
					{ type: "functionCall", name: "list_directory", params: { path: "/" }, result: { items: [] }, startsNewChunk: true },
					{ type: "functionCall", name: "get_context", params: "not json", result: "plain" }
				]
			}
		])
	})

	it("keeps a reply's text and marks no chunk for a template without parallel calls", () => {
		expect(toHistory([{ role: "assistant", content: "Done.", toolCalls: [{ id: "a", name: "x", arguments: "{}" }] }], false)).toEqual([
			{ type: "model", response: ["Done.", { type: "functionCall", name: "x", params: {}, result: null }] }
		])
	})
})

describe("qwen35ChatWrapper", () => {
	it("discourages thinking, and opens calls with Qwen's own call token", () => {
		const wrapper = qwen35ChatWrapper()

		expect(wrapper.wrapperName).toBe("Qwen")
		expect(JSON.stringify(wrapper.settings.functions.call.prefix)).toContain("<tool_call>")
	})
})
