import { describe, expect, it } from "vitest"
import { BATCH_CASES } from "../cases/batch"
import { FakeApp } from "../fakeApp"
import { checkState, diffState } from "../grader"

// The fixture's own answer to each batch case: its call, with the directory the model would have found, leaves exactly
// the state the case expects, so a model that calls it right passes.
const DIRECTORIES: Readonly<Record<string, string>> = {
	"batch-find-then-rename-es": "d5"
}

describe("batch cases", () => {
	for (const evalCase of BATCH_CASES.filter(candidate => candidate.state !== undefined)) {
		it(evalCase.id, () => {
			const app = new FakeApp(evalCase.context)

			evalCase.setup?.(app.state)

			const before = structuredClone(app.state)
			const [expected] = evalCase.calls ?? []

			if (expected === undefined || "anyOf" in expected) {
				throw new Error("a batch case names its call")
			}

			const args = Object.fromEntries(
				Object.entries(expected.args ?? {}).map(([key, value]) => [
					key,
					typeof value === "object" && !Array.isArray(value) && "$includes" in value ? "Lisbon" : value
				])
			)
			const scope = args["scope"] ?? DIRECTORIES[evalCase.id] ?? evalCase.context?.directory

			app.exposed.add(String(scope))

			const outcome = app.execute({ name: expected.tool, args: { ...args, scope } })

			expect(outcome.ok ? null : outcome.error).toBeNull()

			const diff = diffState({ before, after: app.state })

			for (const check of evalCase.state ?? []) {
				expect(checkState({ check, app, diff, lang: evalCase.lang })).toBeNull()
			}
		})
	}

	it("refuses a directory someone else shares, changing nothing", () => {
		const app = new FakeApp()

		app.exposed.add("d50")

		expect(app.execute({ name: "organize_by_date", args: { scope: "d50", by: "month" } })).toMatchObject({ ok: false })
		expect(app.execute({ name: "rename_by_pattern", args: { scope: "d50", scheme: "add_prefix", text: "2025_" } })).toMatchObject({
			ok: false
		})
		expect(app.state).toEqual(new FakeApp().state)
	})
})
