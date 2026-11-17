import { describe, expect, it } from "vitest"
import { SheetGridModel } from "../react/sheet/model"
import type { SheetEntryCheck } from "../react/sheet/layers"
import { BASIC, buildFixture, openFixture } from "./sheetSessionFixtures"

// An entry's text shown until the session answers: a later commit of the same cell owns what the cell shows, so an
// earlier commit's answer (dropped, or written) leaves it alone.

describe("entries waiting for their check", () => {
	it("keep showing a later entry of the same cell when an earlier one's check drops it", async () => {
		const { session, info } = await openFixture(buildFixture(BASIC))
		const model = new SheetGridModel({ source: session, edit: session, info })
		const sheet = info.activeSheet
		const answers: ((verdict: "commit" | "discard") => void)[] = []

		model.setEntryHooks([
			(_entry: SheetEntryCheck) =>
				new Promise<"commit" | "discard">(resolve => {
					answers.push(resolve)
				})
		])

		model.startEditing("50", "enter")

		const first = model.commitEditing(null)

		model.startEditing("5", "enter")

		const second = model.commitEditing(null)

		expect(model.pendingText(sheet, 0, 0)).toBe("5")

		answers[0]?.("discard")
		expect(await first).toBe(false)
		// The second entry is still being checked: the cell shows it.
		expect(model.pendingText(sheet, 0, 0)).toBe("5")

		answers[1]?.("commit")
		expect(await second).toBe(true)
		expect(model.pendingText(sheet, 0, 0)).toBeUndefined()
		session.close()
	})
})
