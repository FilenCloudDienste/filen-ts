import { describe, expect, it } from "vitest"
import type { Transcript } from "../agent"
import { CONVERSATION_CASES } from "../cases/conversation"
import { FakeApp } from "../fakeApp"
import { gradeCase } from "../grader"
import { call, transcript as base } from "./helpers"

function transcript(answer: string): Transcript {
	return base({
		route: "notes",
		intent: "read",
		routeRaw: "notes read",
		calls: [{ ...call("read_note", { handle: "n2" }), step: 2 }],
		answer,
		steps: 3,
		quarantineCalls: 1
	})
}

function grade(id: string, answer: string) {
	const evalCase = CONVERSATION_CASES.find(item => item.id === id)

	if (evalCase === undefined) {
		throw new Error(`missing ${id}`)
	}

	const app = new FakeApp(evalCase.context)

	evalCase.setup?.(app.state)

	return gradeCase({ evalCase, transcript: transcript(answer), app, before: structuredClone(app.state) })
}

describe("conversation cases", () => {
	it("grades the language of a read after an unrelated turn", () => {
		const reads = CONVERSATION_CASES.filter(item => item.id.startsWith("conversation-read-after-unrelated-"))

		expect(reads.length).toBeGreaterThan(0)
		expect(reads.every(item => item.category === "language")).toBe(true)
	})

	it("fails an answer in the earlier turn's language, also one too short for the language detector", () => {
		const id = "conversation-read-after-unrelated-de-en"

		expect(
			grade(id, "Your note Einkaufsliste lists four items: Milch (milk), Käse (cheese), Äpfel and Brot; the bread is checked.").pass
		).toBe(true)
		expect(
			grade(id, "In deiner Einkaufsliste stehen Milch, Käse, Äpfel und Brot. Das Brot ist schon abgehakt, der Rest fehlt noch.").pass
		).toBe(false)
		expect(grade(id, "Deine Einkaufsliste enthält folgende Artikel:\n- [ ] Milch\n- [ ] Käse\n- [ ] Äpfel\n- [x] Brot").pass).toBe(
			false
		)
	})
})
