import { describe, expect, it } from "vitest"
import { joinTitle, titleMeta, routeHead, NOINDEX_META } from "@/lib/head/routeHead"

// Importing routeHead transitively imports @/lib/i18n, which runs its i18next.init() as a module side
// effect — no test-side i18n bootstrap needed, and node-env safe (no DOM, no React render).
describe("joinTitle", () => {
	it("yields the bare app name for no segments", () => {
		expect(joinTitle([], "Filen")).toBe("Filen")
	})

	it("closes a single segment with the app name", () => {
		expect(joinTitle(["Cloud Drive"], "Filen")).toBe("Cloud Drive · Filen")
	})

	it("runs segments most-specific first", () => {
		expect(joinTitle(["Security", "Settings"], "Filen")).toBe("Security · Settings · Filen")
	})

	it("drops empty and whitespace-only segments", () => {
		expect(joinTitle(["", "  ", "Notes"], "Filen")).toBe("Notes · Filen")
	})

	it("trims each segment", () => {
		expect(joinTitle([" Trash "], "Filen")).toBe("Trash · Filen")
	})

	it("yields the bare app name when every segment is empty", () => {
		expect(joinTitle(["", "   "], "Filen")).toBe("Filen")
	})
})

describe("titleMeta", () => {
	it("resolves the app name from the catalog", () => {
		expect(titleMeta()).toEqual([{ title: "Filen" }])
	})

	it("appends the app name to a segment", () => {
		expect(titleMeta("Recents")).toEqual([{ title: "Recents · Filen" }])
	})
})

describe("routeHead", () => {
	it("emits the title on a normal match", () => {
		const head = routeHead({ title: () => ["Recents"] })

		expect(head({ matches: [{ globalNotFound: false }, {}] }).meta).toEqual([{ title: "Recents · Filen" }])
	})

	it("drops the title on a global not-found so the root's own title wins", () => {
		const head = routeHead({ title: () => ["Recents"] })

		expect(head({ matches: [{ globalNotFound: true }, {}] }).meta).toEqual([])
	})

	it("treats an absent globalNotFound field and an absent matches array as a normal match", () => {
		const head = routeHead({ title: () => ["Recents"] })

		expect(head({ matches: [{}] }).meta).toEqual([{ title: "Recents · Filen" }])
		expect(head({}).meta).toEqual([{ title: "Recents · Filen" }])
	})

	it("keeps non-title meta on a global not-found and drops only the title", () => {
		const head = routeHead({ title: () => ["Shared file"], meta: [NOINDEX_META] })

		expect(head({ matches: [{ globalNotFound: false }] }).meta).toEqual([{ title: "Shared file · Filen" }, NOINDEX_META])
		expect(head({ matches: [{ globalNotFound: true }] }).meta).toEqual([NOINDEX_META])
	})

	it("emits meta alone when no title is declared, in both ctx shapes", () => {
		const head = routeHead({ meta: [NOINDEX_META] })

		expect(head({ matches: [{ globalNotFound: false }] }).meta).toEqual([NOINDEX_META])
		expect(head({ matches: [{ globalNotFound: true }] }).meta).toEqual([NOINDEX_META])
	})

	it("calls the title thunk per head run, never at construction", () => {
		// Regression guard for the eager-resolution bug the thunk exists to prevent: route options are
		// evaluated at module import, so a resolved t() would freeze every tab label in the boot language.
		let calls = 0
		const head = routeHead({
			title: () => {
				calls++

				return ["Recents"]
			}
		})

		expect(calls).toBe(0)

		head({ matches: [{ globalNotFound: false }] })

		expect(calls).toBe(1)

		head({ matches: [{ globalNotFound: true }] })

		expect(calls).toBe(1)
	})
})
