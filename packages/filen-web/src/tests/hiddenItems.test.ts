import { describe, expect, it } from "vitest"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { hiddenFilterAppliesTo } from "@/features/drive/lib/hiddenItems"

// filterHiddenItems is shared (see @filen/shared's hiddenItems.test.ts); directoryListing.test.ts
// drives it over real narrowItem shapes through resolveListingDisplayItems.
describe("hiddenFilterAppliesTo", () => {
	it("applies only to the two surfaces you browse your own content on", () => {
		const variants: DriveVariant[] = ["drive", "recents", "favorites", "trash", "links", "sharedIn", "sharedOut"]

		expect(variants.filter(hiddenFilterAppliesTo)).toEqual(["drive", "recents"])
	})
})
