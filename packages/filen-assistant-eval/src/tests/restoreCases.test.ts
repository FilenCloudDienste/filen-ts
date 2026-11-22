import { describe, expect, it } from "vitest"
import { RESTORE_CASES } from "../cases/restore"
import { SOURCES_CASES } from "../cases/sources"
import { LANGUAGES } from "../cases/types"
import { FakeApp } from "../fakeApp"
import { checkState, diffState } from "../grader"

const CASES = [...RESTORE_CASES, ...SOURCES_CASES.filter(evalCase => evalCase.id === "safety-restore-trash-en")]

describe("restore cases", () => {
	it("cover every language", () => {
		expect(new Set(CASES.map(item => item.lang))).toEqual(new Set(LANGUAGES))
		expect(CASES.length).toBeGreaterThanOrEqual(40)
	})

	for (const evalCase of CASES.filter(candidate => candidate.state !== undefined)) {
		it(`${evalCase.id}: the fixture's answer leaves the expected state`, () => {
			const app = new FakeApp(evalCase.context)

			evalCase.setup?.(app.state)

			const before = structuredClone(app.state)
			const [expected] = evalCase.calls ?? []

			if (expected === undefined || "anyOf" in expected) {
				throw new Error("a restore case names its call")
			}

			const handles = evalCase.state?.map(check => ("item" in check ? check.item : "note" in check ? check.note : "")) ?? []

			for (const handle of handles) {
				app.exposed.add(handle)
			}

			expect(app.execute({ name: expected.tool, args: { handles } })).toMatchObject({ ok: true })

			const diff = diffState({ before, after: app.state })

			for (const check of evalCase.state ?? []) {
				expect(checkState({ check, app, diff, lang: evalCase.lang })).toBeNull()
			}
		})
	}

	it("refuses an item that is not in the trash, restoring nothing", () => {
		const app = new FakeApp()

		app.exposed.add("f45")
		app.exposed.add("f44")

		expect(app.execute({ name: "restore_items", args: { handles: ["f45", "f44"] } })).toMatchObject({ ok: false })
		expect(app.state.drive.find(item => item.handle === "f45")?.trashed).toBe(true)
	})

	it("names a trash-screen selection in the context", () => {
		const app = new FakeApp({ screen: "trash", selection: ["f45"] })

		expect(app.contextHandles()).toContain("f45")
	})
})
