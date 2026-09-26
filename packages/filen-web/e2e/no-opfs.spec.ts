import { test, expect } from "./fixtures"

// Boot-independent: the root gate (src/routes/__root.tsx) always renders this route regardless of
// boot phase/reason — mirrors /no-coi (see no-coi.spec.ts). A direct navigation exercises the PAGE
// content only, decoupled from whichever boot-failure path actually reaches the `opfs` reason in a
// real failure (the capability pre-check or the leader's open()-throws path, see @/lib/sdk/boot) — the
// pre-check's own decision is unit-tested in capability.test.ts, not re-proven here.
test.describe("no OPFS storage", () => {
	test("renders the OPFS-required page's copy with a reload action", async ({ page }) => {
		await page.goto("/no-opfs")

		await expect(page.getByText("Persistent storage is unavailable")).toBeVisible()
		await expect(page.getByText("private, persistent file storage (OPFS)")).toBeVisible()
		await expect(page.getByRole("button", { name: "Reload page" })).toBeVisible()
	})
})
