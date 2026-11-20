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
		await expect(executor.check({ tool: tool("set_note_flags"), args: { handle: "n1", archived: true } })).resolves.toMatchObject({
			ok: false,
			invalid: false
		})
		expect(executor.supports(tool("draft_chat_message"))).toBe(true)
		expect(executor.supports(tool("move_items"))).toBe(true)
		expect(executor.supports(tool("trash_items"))).toBe(true)
		expect(executor.supports(tool("add_tracks_to_playlist"))).toBe(false)
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
		const archive: EvalCase = {
			id: "archive",
			category: "multi_step",
			lang: "de",
			prompt: "p",
			routes: ["notes"],
			state: [
				{
					note: "n2",
					archived: true
				}
			],
			mayChange: ["n2"]
		}

		expect(shippedCase(archive)).toMatchObject({ expectsText: true, unavailableWrite: true })
		expect(shippedCase(archive)).not.toHaveProperty("state")
		expect(shippedCase(archive)).not.toHaveProperty("mayChange")
	})

	it("grades a drive or note write the web app runs as written", () => {
		const cases: EvalCase[] = [
			{
				id: "move",
				category: "multi_step",
				lang: "de",
				prompt: "p",
				routes: ["organize"],
				state: [{ item: "f1", parent: "d8" }],
				mayChange: ["f26"]
			},
			{
				id: "trash",
				category: "simple",
				lang: "en",
				prompt: "p",
				routes: ["trash"],
				calls: [{ tool: "trash_items" }],
				state: [{ note: "n2", trashed: true }]
			},
			{
				id: "new",
				category: "simple",
				lang: "en",
				prompt: "p",
				routes: ["notes"],
				calls: [{ tool: "create_note" }],
				state: [{ newNote: { titleIncludes: ["x"] } }]
			}
		]

		for (const evalCase of cases) {
			expect(shippedCase(evalCase), evalCase.id).toBe(evalCase)
		}
	})

	it("grades a case that calls a tool the web app does not run as a plain reply, without the expected calls or facts", () => {
		const shipped = shippedCase({
			id: "add",
			category: "multi_step",
			lang: "en",
			prompt: "p",
			routes: ["audio"],
			calls: [{ tool: "add_tracks_to_playlist" }],
			mayChange: ["p1"],
			answerIncludes: [["playlist"]]
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
