import { test, expect } from "./fixtures"

const SESSION_SLOT = "filen.e2e.session"

test.describe("storage", () => {
	test("kv values persist across a reload", async ({ page }) => {
		await page.goto("/")
		await page.waitForFunction(() => "__filenE2E" in window)

		await page.evaluate(() => window.__filenE2E.kvSet("e2e.storage.persist", "persisted-value"))
		await page.reload()
		await page.waitForFunction(() => "__filenE2E" in window)

		const value = await page.evaluate(() => window.__filenE2E.kvGet("e2e.storage.persist"))
		expect(value).toBe("persisted-value")
	})

	test("a follower tab reads a value written by the leader tab through the BroadcastChannel RPC", async ({
		page,
		injectedSession,
		context,
		browserName
	}) => {
		// Opening a second SDK-worker tab under COI crashes navigation on Playwright-firefox; the
		// leader/follower election is verified on chromium.
		test.skip(browserName === "firefox", "a second SDK-worker tab is unstable on Playwright-firefox under COI")

		expect(injectedSession.length).toBeGreaterThan(0)

		// Leader tab: wins the Web Lock, opens OPFS directly, and writes a value into its own sqlite.
		await page.goto("/")
		await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()
		await page.evaluate(() => window.__filenE2E.kvSet("e2e.storage.leader", "from-leader"))

		// Follower tab: the lock is already held, so it reads through the BroadcastChannel RPC instead
		// of opening its own OPFS handle.
		const follower = await context.newPage()

		await follower.addInitScript(
			([slot, blob]) => {
				sessionStorage.setItem(slot, blob)
			},
			[SESSION_SLOT, injectedSession] as const
		)
		await follower.goto("/")

		await expect(follower.getByRole("navigation", { name: "Filen" })).toBeVisible()

		const readThrough = await follower.evaluate(() => window.__filenE2E.kvGet("e2e.storage.leader"))
		expect(readThrough).toBe("from-leader")

		await follower.close()
	})
})
