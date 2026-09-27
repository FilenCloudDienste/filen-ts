import { describe, expect, it } from "vitest"
import { conflictCopyName, conflictCopyStamp, decideRevision, isRevisionOf, PushEchoes, settleHeldRevisions } from "@filen/shared"

describe("isRevisionOf", () => {
	const v1 = { uuid: "v1", stableUuid: "lineage" }

	it("follows the file by its stable id, not its uuid", () => {
		expect(isRevisionOf(v1, { uuid: "v2", stableUuid: "lineage" })).toBe(true)
		expect(isRevisionOf(v1, { uuid: "v2", stableUuid: "other" })).toBe(false)
	})

	it("is not a revision when the version is the one already shown (its own save, or a repeat)", () => {
		expect(isRevisionOf(v1, { uuid: "v1", stableUuid: "lineage" })).toBe(false)
	})

	it("falls back to the replaced uuid for a file listed without a stable id", () => {
		expect(isRevisionOf({ uuid: "v1", stableUuid: undefined }, { uuid: "v2", stableUuid: undefined, previousUuid: "v1" })).toBe(true)
		expect(isRevisionOf({ uuid: "v1", stableUuid: undefined }, { uuid: "v2", stableUuid: undefined })).toBe(false)
	})
})

describe("decideRevision", () => {
	const base = { current: true, dirty: false, saving: false, keptOver: undefined, revisionUuid: "v2" }

	it("shows a revision of something off screen without a word", () => {
		expect(decideRevision({ ...base, current: false, dirty: true, saving: true })).toEqual({ type: "show", announce: false })
	})

	it("shows and announces a revision of a clean file on screen", () => {
		expect(decideRevision(base)).toEqual({ type: "show", announce: true })
	})

	it("asks over unsaved edits", () => {
		expect(decideRevision({ ...base, dirty: true })).toEqual({ type: "ask" })
	})

	it("holds a revision while the editor's own save is in flight, as it may be that save's echo", () => {
		expect(decideRevision({ ...base, dirty: true, saving: true })).toEqual({ type: "hold" })
	})

	it("does not ask twice about the revision the user kept their edits over", () => {
		expect(decideRevision({ ...base, dirty: true, keptOver: "v2" })).toEqual({ type: "ignore" })
		expect(decideRevision({ ...base, dirty: true, keptOver: "v1" })).toEqual({ type: "ask" })
	})
})

describe("settleHeldRevisions", () => {
	const uuidOf = (revision: string) => revision

	it("drops the save's own echo", () => {
		expect(settleHeldRevisions(["mine"], "mine", uuidOf)).toEqual({ replaced: false, newer: [] })
	})

	it("reports the versions the save went over, and keeps the ones after it", () => {
		expect(settleHeldRevisions(["theirs", "mine", "later"], "mine", uuidOf)).toEqual({ replaced: true, newer: ["later"] })
	})

	it("counts every held version as replaced while the echo has not arrived", () => {
		expect(settleHeldRevisions(["theirs"], "mine", uuidOf)).toEqual({ replaced: true, newer: [] })
		expect(settleHeldRevisions([], "mine", uuidOf)).toEqual({ replaced: false, newer: [] })
	})

	it("keeps every held version after a failed save, which made nothing", () => {
		expect(settleHeldRevisions(["theirs", "later"], null, uuidOf)).toEqual({ replaced: false, newer: ["theirs", "later"] })
	})
})

describe("conflictCopyName", () => {
	const label = ({ base, date, ext }: { base: string; date: string; ext: string }) => `${base} (conflicted copy ${date})${ext}`
	const at = new Date(2026, 8, 27, 9, 5)

	it("stamps the time without colons", () => {
		expect(conflictCopyStamp(at)).toBe("2026-09-27 09-05")
	})

	it("names the copy after the file and the time, keeping the extension as written", async () => {
		expect(await conflictCopyName("Notes.MD", at, label, () => Promise.resolve(false))).toBe(
			"Notes (conflicted copy 2026-09-27 09-05).MD"
		)
		expect(await conflictCopyName("Makefile", at, label, () => Promise.resolve(false))).toBe(
			"Makefile (conflicted copy 2026-09-27 09-05)"
		)
		expect(await conflictCopyName(".env", at, label, () => Promise.resolve(false))).toBe(".env (conflicted copy 2026-09-27 09-05)")
	})

	it("counts up while the name is taken", async () => {
		const taken = new Set(["a (conflicted copy 2026-09-27 09-05).txt", "a (conflicted copy 2026-09-27 09-05 2).txt"])

		expect(await conflictCopyName("a.txt", at, label, name => Promise.resolve(taken.has(name)))).toBe(
			"a (conflicted copy 2026-09-27 09-05 3).txt"
		)
	})
})

describe("PushEchoes", () => {
	it("recognises what was pushed, per item, and forgets the oldest past the cap", () => {
		const echoes = new PushEchoes(2)

		echoes.remember("a", "h1")
		echoes.remember("a", "h2")
		echoes.remember("a", "h3")

		expect(echoes.isOwn("a", "h1")).toBe(false)
		expect(echoes.isOwn("b", "h3")).toBe(false)
		expect(echoes.isOwn("a", "h3")).toBe(true)

		echoes.remember("a", "h4")
		echoes.clear()

		expect(echoes.isOwn("a", "h4")).toBe(false)
	})

	it("takes each push's echo once, so a revert saved on another device to content pushed here is not an echo", () => {
		const echoes = new PushEchoes()

		echoes.remember("a", "c1")
		echoes.remember("a", "c0")

		expect(echoes.isOwn("a", "c1")).toBe(true)
		expect(echoes.isOwn("a", "c0")).toBe(true)
		// Another device of the account saves c1 again.
		expect(echoes.isOwn("a", "c1")).toBe(false)
	})

	it("consumes the pushes older than the echo that matched, whose own echoes never came", () => {
		const echoes = new PushEchoes()

		echoes.remember("a", "c0")
		echoes.remember("a", "c1")
		echoes.remember("a", "c2")

		expect(echoes.isOwn("a", "c1")).toBe(true)
		expect(echoes.isOwn("a", "c0")).toBe(false)
		expect(echoes.isOwn("a", "c2")).toBe(true)
	})

	it("matches the oldest of two identical pushes first, leaving the newer one for its own echo", () => {
		const echoes = new PushEchoes()

		echoes.remember("a", "c1")
		echoes.remember("a", "c1")

		expect(echoes.isOwn("a", "c1")).toBe(true)
		expect(echoes.isOwn("a", "c1")).toBe(true)
		expect(echoes.isOwn("a", "c1")).toBe(false)
	})
})
