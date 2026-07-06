import { test, expect } from "./fixtures"

const SESSION_SLOT = "filen.e2e.session"

test.describe("storage", () => {
	test("kv values persist across a reload on the persistent backend", async ({ page }) => {
		await page.goto("/")
		await page.waitForFunction(() => "__filenE2E" in window)

		await page.evaluate(() => window.__filenE2E.kvSet("e2e.storage.persist", "persisted-value"))
		await page.reload()
		await page.waitForFunction(() => "__filenE2E" in window)

		const value = await page.evaluate(() => window.__filenE2E.kvGet("e2e.storage.persist"))
		expect(value).toBe("persisted-value")
	})

	test("ephemeral mode shows the indicator and does not persist", async ({ page, injectedSession, browserName }) => {
		// Reloading the authed shell under COI intermittently trips a Corrupted Content Error on
		// Playwright-firefox; the ephemeral indicator + non-persistence are verified on chromium.
		test.skip(browserName === "firefox", "reloading the authed shell is unstable on Playwright-firefox under COI")

		expect(injectedSession.length).toBeGreaterThan(0)

		await page.goto("/?ephemeral=1")

		// Authed shell renders; the backend was chosen ephemeral from the initial URL, so the rail shows
		// the ephemeral indicator (aria-label from the ephemeralSession catalog key).
		await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()
		await expect(page.getByLabel("Ephemeral session")).toBeVisible()

		await page.evaluate(() => window.__filenE2E.kvSet("e2e.storage.ephemeral", "gone"))

		// The in-memory backend does not survive a reload — the value is gone. (A reload, not a second
		// goto: re-navigating to the same URL intermittently trips a Corrupted Content Error on
		// Playwright-firefox under COI.)
		await page.reload()
		await page.waitForFunction(() => "__filenE2E" in window)

		const value = await page.evaluate(() => window.__filenE2E.kvGet("e2e.storage.ephemeral"))
		expect(value).toBeNull()
	})

	test("a follower tab reads through the leader and reflects its ephemeral mode", async ({
		page,
		injectedSession,
		context,
		browserName
	}) => {
		// Opening a second SDK-worker tab under COI crashes navigation on Playwright-firefox; the
		// leader/follower election is verified on chromium.
		test.skip(browserName === "firefox", "a second SDK-worker tab is unstable on Playwright-firefox under COI")

		expect(injectedSession.length).toBeGreaterThan(0)

		// Leader tab: ephemeral, writes a value into the leader-owned sqlite.
		await page.goto("/?ephemeral=1")
		await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()
		await expect(page.getByLabel("Ephemeral session")).toBeVisible()
		await page.evaluate(() => window.__filenE2E.kvSet("e2e.storage.leader", "from-leader"))

		// Follower tab: opened WITHOUT ?ephemeral — it must still report ephemeral (it asks the leader,
		// never assumes) and read the leader's value through the BroadcastChannel RPC.
		const follower = await context.newPage()

		await follower.addInitScript(
			([slot, blob]) => {
				sessionStorage.setItem(slot, blob)
			},
			[SESSION_SLOT, injectedSession] as const
		)
		await follower.goto("/")

		await expect(follower.getByRole("navigation", { name: "Filen" })).toBeVisible()
		await expect(follower.getByLabel("Ephemeral session")).toBeVisible()

		const readThrough = await follower.evaluate(() => window.__filenE2E.kvGet("e2e.storage.leader"))
		expect(readThrough).toBe("from-leader")

		await follower.close()
	})
})
