import { describe, expect, it } from "vitest"
import { STALE_RELOAD_COOLDOWN_MS, staleChunkAction } from "@/lib/appUpdate.logic"

const base = { online: true, busy: false, lastReloadAt: null, now: 1_000_000 }

describe("staleChunkAction", () => {
	it("reloads an idle online tab", () => {
		expect(staleChunkAction(base)).toBe("reload")
	})

	it("does nothing offline, even when busy", () => {
		expect(staleChunkAction({ ...base, online: false })).toBe("none")
		expect(staleChunkAction({ ...base, online: false, busy: true })).toBe("none")
	})

	it("prompts instead of reloading while something holds the tab", () => {
		expect(staleChunkAction({ ...base, busy: true })).toBe("prompt")
	})

	it("prompts while busy even right after a reload", () => {
		expect(staleChunkAction({ ...base, busy: true, lastReloadAt: base.now - 1 })).toBe("prompt")
	})

	it("does not reload again within the cooldown", () => {
		expect(staleChunkAction({ ...base, lastReloadAt: base.now - STALE_RELOAD_COOLDOWN_MS + 1 })).toBe("none")
	})

	it("reloads again once the cooldown has passed", () => {
		expect(staleChunkAction({ ...base, lastReloadAt: base.now - STALE_RELOAD_COOLDOWN_MS })).toBe("reload")
	})
})
