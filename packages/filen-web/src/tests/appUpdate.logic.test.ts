import { describe, expect, it } from "vitest"
import { isBuildStillDeployed, STALE_RELOAD_COOLDOWN_MS, staleBuildAction } from "@/lib/appUpdate.logic"

const base = { busy: false, lastReloadAt: null, now: 1_000_000 }

describe("staleBuildAction", () => {
	it("reloads an idle tab", () => {
		expect(staleBuildAction(base)).toBe("reload")
	})

	it("prompts instead of reloading while something holds the tab", () => {
		expect(staleBuildAction({ ...base, busy: true })).toBe("prompt")
	})

	it("prompts while busy even right after a reload", () => {
		expect(staleBuildAction({ ...base, busy: true, lastReloadAt: base.now - 1 })).toBe("prompt")
	})

	it("does not reload again within the cooldown", () => {
		expect(staleBuildAction({ ...base, lastReloadAt: base.now - STALE_RELOAD_COOLDOWN_MS + 1 })).toBe("none")
	})

	it("reloads again once the cooldown has passed", () => {
		expect(staleBuildAction({ ...base, lastReloadAt: base.now - STALE_RELOAD_COOLDOWN_MS })).toBe("reload")
	})
})

describe("isBuildStillDeployed", () => {
	const html = '<script type="module" crossorigin src="/assets/index-AbC123.js"></script>'

	it("is true while index.html loads the running bundle", () => {
		expect(isBuildStillDeployed(html, "/assets/index-AbC123.js")).toBe(true)
	})

	it("is false once a deploy references another bundle", () => {
		expect(isBuildStillDeployed(html, "/assets/index-Old999.js")).toBe(false)
	})
})
