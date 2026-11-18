import { describe, expect, it } from "vitest"
import { assistantToolByName, type AssistantTool } from "@filen/shared/assistant"
import type { EvalCase } from "../cases/types"
import { FakeApp } from "../fakeApp"
import { FakeAppExecutor, LOOP_PRESETS, shippedCase, toHistory } from "../loopHarness"

function tool(name: string): AssistantTool {
	const found = assistantToolByName(name)

	if (found === undefined) {
		throw new Error(name)
	}

	return found
}

describe("loop harness", () => {
	it("puts each tool result onto the call it answers, in the model turn that made it", () => {
		expect(
			toHistory(
				[
					{ role: "system", content: "s" },
					{ role: "user", content: "u" },
					{
						role: "assistant",
						content: "",
						toolCalls: [{ id: "a", name: "search_items", arguments: JSON.stringify({ query: "x" }) }]
					},
					{ role: "tool", toolCallId: "a", content: JSON.stringify({ results: [] }) }
				],
				true
			)
		).toEqual([
			{ type: "system", text: "s" },
			{ type: "user", text: "u" },
			{
				type: "model",
				response: [
					{ type: "functionCall", name: "search_items", params: { query: "x" }, result: { results: [] }, startsNewChunk: true }
				]
			}
		])
	})

	it("checks calls as the web app does: paths resolve, unknown handles fail, writes it does not run are refused", async () => {
		const executor = new FakeAppExecutor(new FakeApp(), LOOP_PRESETS.shipped.supports)

		await expect(executor.check({ tool: tool("list_directory"), args: { handle: "/Documents" } })).resolves.toEqual({
			ok: true,
			args: { handle: "d1" }
		})
		await expect(executor.check({ tool: tool("list_directory"), args: { handle: "d99" } })).resolves.toMatchObject({
			ok: false,
			invalid: true
		})
		await expect(executor.check({ tool: tool("trash_items"), args: { handles: ["d1"] } })).resolves.toMatchObject({
			ok: false,
			invalid: false
		})
		expect(executor.supports(tool("draft_chat_message"))).toBe(true)
		expect(executor.supports(tool("move_items"))).toBe(false)
	})

	it("marks no call as starting a chunk for a wrapper without parallel calls", () => {
		const history = toHistory(
			[
				{ role: "user", content: "u" },
				{
					role: "assistant",
					content: "",
					toolCalls: [{ id: "a", name: "search_items", arguments: JSON.stringify({ query: "x" }) }]
				}
			],
			false
		)

		expect(history[1]).toEqual({
			type: "model",
			response: [{ type: "functionCall", name: "search_items", params: { query: "x" }, result: null }]
		})
		expect(history[1]?.type === "model" ? history[1].response[0] : undefined).not.toHaveProperty("startsNewChunk")
	})

	it("keeps the text beside the calls, opens the chunk on the first call only and answers each call by id", () => {
		expect(
			toHistory(
				[
					{
						role: "assistant",
						content: "t",
						toolCalls: [
							{ id: "a", name: "search_items", arguments: JSON.stringify({ query: "x" }) },
							{ id: "b", name: "list_directory", arguments: JSON.stringify({ handle: "d1" }) }
						]
					},
					{ role: "tool", toolCallId: "b", content: JSON.stringify({ items: [] }) },
					{ role: "tool", toolCallId: "a", content: JSON.stringify({ results: [] }) }
				],
				true
			)
		).toEqual([
			{
				type: "model",
				response: [
					"t",
					{ type: "functionCall", name: "search_items", params: { query: "x" }, result: { results: [] }, startsNewChunk: true },
					{ type: "functionCall", name: "list_directory", params: { handle: "d1" }, result: { items: [] } }
				]
			}
		])
	})

	it("leaves a call unanswered by a tool message for another id, and keeps arguments and results that are not JSON", () => {
		expect(
			toHistory(
				[
					{
						role: "assistant",
						content: "",
						toolCalls: [
							{ id: "a", name: "search_items", arguments: "{query" },
							{ id: "b", name: "list_directory", arguments: JSON.stringify({ handle: "d1" }) }
						]
					},
					{ role: "tool", toolCallId: "a", content: "not json" },
					{ role: "tool", toolCallId: "z", content: JSON.stringify({ items: [] }) }
				],
				true
			)
		).toEqual([
			{
				type: "model",
				response: [
					{ type: "functionCall", name: "search_items", params: "{query", result: "not json", startsNewChunk: true },
					{ type: "functionCall", name: "list_directory", params: { handle: "d1" }, result: null }
				]
			}
		])
	})

	it("grades a case that needs a write the web app does not run as a plain reply that changes nothing", () => {
		const move: EvalCase = {
			id: "move",
			category: "multi_step",
			lang: "de",
			prompt: "p",
			routes: ["organize"],
			state: [
				{
					item: "f1",
					parent: "d8"
				}
			],
			mayChange: ["f26"]
		}

		expect(shippedCase(move)).toMatchObject({ expectsText: true, unavailableWrite: true })
		expect(shippedCase(move)).not.toHaveProperty("state")
		expect(shippedCase(move)).not.toHaveProperty("mayChange")
	})

	it("grades a case that calls a tool the web app does not run as a plain reply, without the expected calls or facts", () => {
		const shipped = shippedCase({
			id: "move",
			category: "multi_step",
			lang: "en",
			prompt: "p",
			routes: ["organize"],
			calls: [{ tool: "move_items" }],
			mayChange: ["f1"],
			answerIncludes: [["archive"]]
		})

		expect(shipped).toMatchObject({ expectsText: true, unavailableWrite: true })

		for (const key of ["calls", "state", "mayChange", "answerIncludes"]) {
			expect(shipped).not.toHaveProperty(key)
		}
	})

	it("grades a case that only opens a screen, drafts or plays as written", () => {
		const cases: EvalCase[] = [
			{
				id: "screen",
				category: "simple",
				lang: "en",
				prompt: "p",
				routes: ["chats"],
				calls: [{ tool: "open_chat" }],
				state: [{ screen: "chats", opened: "c1" }]
			},
			{
				id: "draft",
				category: "multi_step",
				lang: "en",
				prompt: "p",
				routes: ["chats"],
				calls: [{ anyOf: [{ tool: "draft_chat_message" }, { tool: "open_chat" }] }],
				state: [{ draft: "c1", textIncludes: ["hetzner"] }]
			},
			{
				id: "playing",
				category: "simple",
				lang: "en",
				prompt: "p",
				routes: ["chats"],
				calls: [{ tool: "play" }],
				state: [{ playing: "a1" }]
			}
		]

		for (const evalCase of cases) {
			expect(shippedCase(evalCase)).toBe(evalCase)
		}
	})
})
