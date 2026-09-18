import { test, expect } from "./fixtures"
import { waitForE2eHooks } from "./helpers/e2eHooks"
import { bootTo } from "./helpers/listing"
import { SESSION_SLOT } from "@/e2e-hooks/sessionSlot"

test.describe("storage", () => {
	test("kv values persist across a reload", async ({ page }) => {
		await page.goto("/")
		await waitForE2eHooks(page)

		await page.evaluate(() => window.__filenE2E.kvSet("e2e.storage.persist", "persisted-value"))

		// Retried because Playwright-firefox aborts a reload issued while the first load still has a
		// request in flight (NS_BINDING_ABORTED) — the boot fires several, so on a slow runner the race
		// is ordinary rather than exceptional. That abort fails fast, so the barrier's own budget inside
		// still leaves room for a second attempt. Re-reloading is safe: the value under test is already
		// written, and the assertion below is what proves the reload happened at all.
		await expect(async () => {
			await page.reload()
			await waitForE2eHooks(page)
		}).toPass({ timeout: 60_000 })

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
		await bootTo(page, "/")
		await waitForE2eHooks(page)
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
		// The blocking startup reminders arm per page load — the follower is its own load, so it gets
		// its own boot barrier.
		await bootTo(follower, "/")
		await waitForE2eHooks(follower)

		const readThrough = await follower.evaluate(() => window.__filenE2E.kvGet("e2e.storage.leader"))
		expect(readThrough).toBe("from-leader")

		await follower.close()
	})

	test("a follower is promoted to leader when the leader tab dies, and its kv keeps working", async ({
		page,
		injectedSession,
		context,
		browserName
	}) => {
		test.skip(browserName === "firefox", "a second SDK-worker tab is unstable on Playwright-firefox under COI")

		expect(injectedSession.length).toBeGreaterThan(0)

		// The LEADER is a sibling tab booted first (it wins the Web Lock, opens OPFS, writes a value). The
		// fixture `page` is the FOLLOWER + survivor: it reads through the RPC while the leader lives, then
		// takes over the SAME lock — reopening the shared OPFS — once the leader dies.
		const leader = await context.newPage()

		await leader.addInitScript(
			([slot, blob]) => {
				sessionStorage.setItem(slot, blob)
			},
			[SESSION_SLOT, injectedSession] as const
		)
		await bootTo(leader, "/")
		await waitForE2eHooks(leader)
		await leader.evaluate(() => window.__filenE2E.kvSet("e2e.storage.failover", "before-handoff"))

		// Follower boots second → reads through the BroadcastChannel RPC (proves the leader holds the lock).
		await bootTo(page, "/")
		await waitForE2eHooks(page)
		expect(await page.evaluate(() => window.__filenE2E.kvGet("e2e.storage.failover"))).toBe("before-handoff")

		// Kill the leader. The released Web Lock promotes the follower, which opens its own OPFS handle on
		// the SAME origin storage — so the leader's persisted value is still readable, and new writes land.
		// The follower's RPC to the now-dead leader rejects until promotion swaps it to a direct worker, so
		// the in-page read swallows that transient throw (returns null) and the poll rides over the handoff.
		await leader.close()

		await expect
			.poll(() => page.evaluate(() => window.__filenE2E.kvGet("e2e.storage.failover").catch(() => null)), { timeout: 30_000 })
			.toBe("before-handoff")

		// Promotion has settled (the read above went direct) — a fresh write now round-trips through the
		// promoted tab's own worker. Enveloped: the poll above proves the promoted tab can READ, and the
		// write path adopts the promoted worker on its own schedule, so a kvSet issued a beat early
		// rejects against the dead leader's channel rather than failing this claim.
		await expect(async () => {
			await page.evaluate(() => window.__filenE2E.kvSet("e2e.storage.failover", "after-handoff"))
			expect(await page.evaluate(() => window.__filenE2E.kvGet("e2e.storage.failover"))).toBe("after-handoff")
		}).toPass({ timeout: 30_000 })
	})
})
