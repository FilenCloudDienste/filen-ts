import { describe, expect, it } from "vitest"
import type { Transcript } from "../agent"
import { EVAL_CASES } from "../cases"
import type { EvalCase } from "../cases/types"
import { FakeApp } from "../fakeApp"
import { gradeCase } from "../grader"
import { FakeAppExecutor, LOOP_PRESETS, shippedCase } from "../loopHarness"
import { transcript as base } from "./helpers"

// The fake app and the graders as the web app behaves: what the context grounds, how search builds its pool,
// what a draft and an unavailable write are graded on.
function transcript(overrides: Partial<Transcript> = {}): Transcript {
	return base({ route: "chats", intent: "read", routeRaw: "chats read", answer: "Done.", ...overrides })
}

describe("fake app fidelity", () => {
	it("grounds only what the context line names, never what an earlier turn listed", async () => {
		const app = new FakeApp()
		const executor = new FakeAppExecutor(app, LOOP_PRESETS.shipped.supports)

		app.execute({ name: "list_chats", args: {} })

		expect(app.exposed.has("c1")).toBe(true)
		await expect(executor.context()).resolves.toMatchObject({ handles: ["d0"] })
	})

	it("names the open note and chat, and the directory only on a drive screen", () => {
		expect(new FakeApp({ screen: "notes", note: "n3" }).describeContext()).toBe(
			`screen: notes; open note: ${JSON.stringify("Meeting 2025-10-01")} (handle n3); nothing playing`
		)
		expect(new FakeApp({ screen: "chats", chat: "c2" }).contextHandles()).toEqual(["d0", "c2"])
		expect(
			new FakeApp({
				screen: "audio",
				playing: { handle: "f17", playlist: "p2", paused: false, shuffle: false, repeat: false }
			}).describeContext()
		).toBe(`screen: audio; playing: ${JSON.stringify("Clair de Lune.flac")} (handle f17)`)
	})

	it("searches as the app's engine does: one word's names, the next word when one matches none, accents as written", () => {
		const app = new FakeApp()
		const results = (query: string) =>
			(app.execute({ name: "search_items", args: { query } }) as { ok: true; result: { results: { name: string }[]; note?: string } })
				.result

		expect(results("tax return")).toMatchObject({
			results: [{ name: "tax_notes_2024.txt" }],
			note: "No name contains all of the words; these contain only some of them."
		})
		expect(results("Steuererklarung").results).toEqual([])
		expect(results("Steuererklarung 2024").results.map(row => row.name)).toContain("Steuererklärung_2024.pdf")
	})

	it("plays a directory's audio files from the first by name, and refuses a draft over unsent text", () => {
		const app = new FakeApp()

		app.exposed.add("d7")
		expect(app.execute({ name: "play", args: { handle: "d7" } })).toMatchObject({ ok: true, result: { playing: "Bella Ciao.mp3" } })

		app.state.busyComposers = ["c1"]
		app.exposed.add("c1")
		expect(app.execute({ name: "draft_chat_message", args: { chat: "c1", text: "Hi" } })).toMatchObject({ ok: false, invalid: false })
		expect(app.state.draft).toBeNull()
	})

	it("counts office files as documents, as the app does", () => {
		const app = new FakeApp()

		app.exposed.add("d12")

		const names = (
			app.execute({ name: "list_directory", args: { handle: "d12", kind: "document" } }) as {
				ok: true
				result: { items: { name: string }[] }
			}
		).result.items.map(item => item.name)

		expect(names).toEqual(expect.arrayContaining(["Presentacion_kickoff.pptx", "Carta_hotel.doc", "presupuesto.xlsx"]))
	})

	it("marks unread chats and those the user wrote last", () => {
		const app = new FakeApp()
		const chats = (app.execute({ name: "list_chats", args: {} }) as { ok: true; result: { chats: Record<string, unknown>[] } }).result
			.chats

		expect(chats.find(chat => chat["handle"] === "c1")).toMatchObject({ unread: true })
		expect(chats.find(chat => chat["handle"] === "c3")).toMatchObject({ lastFrom: "you" })
	})
})

describe("graders", () => {
	it("fails a case that drafted a message nobody asked for", () => {
		const evalCase: EvalCase = {
			id: "x",
			category: "simple",
			lang: "en",
			prompt: "What did Tom write?",
			routes: ["chats"],
			expectsText: true
		}
		const before = new FakeApp().state
		const app = new FakeApp()

		app.state.draft = { chat: "c4", text: "Sure" }

		const grade = gradeCase({ evalCase, transcript: transcript(), app, before })

		expect(grade.pass).toBe(false)
		expect(grade.reasons).toContain("unexpected change to draft")
	})

	it("grades a draft's language when the case asks", () => {
		const evalCase: EvalCase = {
			id: "x",
			category: "multi_step",
			lang: "ja",
			prompt: "下書きを書いて",
			routes: ["chats"],
			state: [{ draft: "c5", textIncludes: ["friday", "金曜"], inLanguage: true }]
		}
		const before = new FakeApp().state
		const app = new FakeApp()

		app.state.draft = { chat: "c5", text: "I am free on Friday, so we can meet at the office and talk about the report then." }

		expect(gradeCase({ evalCase, transcript: transcript(), app, before }).reasons).toContain("draft written in en")
	})

	it("fails an unavailable write that was misrouted, and lists it apart", () => {
		const favorite = EVAL_CASES.find(item => item.id === "multiple-favorite-note-de")

		if (favorite === undefined) {
			throw new Error("no case")
		}

		const shipped = shippedCase(favorite)
		const app = new FakeApp(favorite.context)
		const before = structuredClone(app.state)

		expect(shipped.unavailableWrite).toBe(true)
		expect(gradeCase({ evalCase: shipped, transcript: transcript({ route: "answer", answer: "Erledigt." }), app, before }).pass).toBe(
			false
		)
		expect(
			gradeCase({ evalCase: shipped, transcript: transcript({ route: "notes", answer: "Das kann ich hier nicht." }), app, before })
				.pass
		).toBe(true)
	})
})
