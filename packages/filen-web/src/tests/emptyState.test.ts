import { describe, expect, it } from "vitest"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import { driveEmptyStateCopy } from "@/features/drive/components/emptyState.logic"

// Every listing surface gets its own bespoke icon/copy pair, not one generic pair reused
// everywhere. Pins that every DriveVariant has a distinct title/body key from every other variant
// (the only property this table actually needs to hold — the exact wording lives in the locale
// catalog, verified separately by the typed-catalog compile check).
describe("driveEmptyStateCopy", () => {
	const variants: DriveVariant[] = ["drive", "trash", "favorites", "recents", "sharedIn", "sharedOut", "links"]

	it.each(variants)("returns a copy entry for the %s variant", variant => {
		const copy = driveEmptyStateCopy(variant)

		expect(copy.icon).toBeDefined()
		expect(copy.titleKey).toBeTruthy()
		expect(copy.bodyKey).toBeTruthy()
	})

	it("gives every variant its own distinct title key — no two surfaces share generic copy", () => {
		const titleKeys = variants.map(variant => driveEmptyStateCopy(variant).titleKey)

		expect(new Set(titleKeys).size).toBe(variants.length)
	})

	it("gives every variant its own distinct body key", () => {
		const bodyKeys = variants.map(variant => driveEmptyStateCopy(variant).bodyKey)

		expect(new Set(bodyKeys).size).toBe(variants.length)
	})

	it("drive variant resolves to the generic driveEmptyTitle/Body keys (also used by the move/import picker)", () => {
		expect(driveEmptyStateCopy("drive")).toMatchObject({ titleKey: "driveEmptyTitle", bodyKey: "driveEmptyBody" })
	})
})
