import { describe, expect, it } from "vitest"
import { BATCH_CASES } from "../cases/batch"
import { LANGUAGES } from "../cases/types"
import { FakeApp } from "../fakeApp"
import { checkState, diffState } from "../grader"

// The fixture's own answer to each batch case: its call, on the directory the model would have found, leaves exactly
// the state the case expects, so a model that calls it right passes.
describe("batch cases", () => {
	it("cover every language and the plan's categories", () => {
		expect(new Set(BATCH_CASES.map(item => item.lang))).toEqual(new Set(LANGUAGES))
		expect(BATCH_CASES.length).toBeGreaterThanOrEqual(80)

		for (const category of ["simple", "multi_step", "missing_param", "safety"] as const) {
			expect(BATCH_CASES.filter(item => item.category === category).length, category).toBeGreaterThanOrEqual(6)
		}
	})

	for (const evalCase of BATCH_CASES.filter(candidate => candidate.state !== undefined)) {
		it(evalCase.id, () => {
			const app = new FakeApp(evalCase.context)

			evalCase.setup?.(app.state)

			const before = structuredClone(app.state)
			const [expected] = evalCase.calls ?? []

			if (expected === undefined || "anyOf" in expected) {
				throw new Error("a batch case names its call")
			}

			const args: Record<string, unknown> = Object.fromEntries(
				Object.entries(expected.args ?? {}).map(([key, value]) => [
					key,
					typeof value === "object" && !Array.isArray(value) && "$includes" in value ? "Lisbon" : value
				])
			)

			if (expected.tool === "rename_by_pattern" && args["scope"] === undefined) {
				// The directory of the files the case renames.
				const [first] = evalCase.state ?? []
				const parent =
					first !== undefined && "item" in first ? app.state.drive.find(item => item.handle === first.item)?.parent : null

				args["scope"] = parent
			}

			for (const handle of Object.values(args).filter(value => typeof value === "string")) {
				app.exposed.add(handle)
			}

			const outcome = app.execute({ name: expected.tool, args })

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

	it("refuses more files than a batch may change, changing nothing", () => {
		const overCap = BATCH_CASES.find(item => item.id === "batch-over-cap-en")
		const app = new FakeApp(overCap?.context)

		overCap?.setup?.(app.state)

		const before = structuredClone(app.state)

		app.exposed.add("d70")

		expect(app.execute({ name: "organize_by_date", args: { scope: "d70", by: "month" } })).toMatchObject({ ok: false })
		expect(app.state).toEqual(before)
	})
})
