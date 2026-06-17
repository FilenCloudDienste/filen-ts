import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// installDomConsoleProxy overrides globalThis.console.* — save/restore around each test, and run
// against a fresh module instance (its install-once flag is module-level).
describe("installDomConsoleProxy", () => {
	const saved: Record<string, unknown> = {}
	const methods = ["log", "info", "warn", "error", "debug"] as const

	beforeEach(() => {
		for (const m of methods) {
			saved[m] = (globalThis.console as unknown as Record<string, unknown>)[m]
			// no-op the originals so the proxy's pass-through call produces no test-output noise
			;(globalThis.console as unknown as Record<string, unknown>)[m] = () => {}
		}

		vi.resetModules()
	})

	afterEach(() => {
		for (const m of methods) {
			;(globalThis.console as unknown as Record<string, unknown>)[m] = saved[m]
		}

		delete (globalThis as unknown as Record<string, unknown>)["ReactNativeWebView"]
	})

	it("forwards console.error as a __filenLog envelope over ReactNativeWebView", async () => {
		const posted: string[] = []
		;(globalThis as unknown as Record<string, unknown>)["ReactNativeWebView"] = {
			postMessage: (m: string) => {
				posted.push(m)
			}
		}

		const { installDomConsoleProxy } = await import("@/hooks/useDomEvents/domConsoleProxy")

		installDomConsoleProxy()
		globalThis.console.error("boom", 42)

		expect(posted.length).toBe(1)

		const parsed = JSON.parse(posted[0] ?? "{}") as { __filenLog: { level: string; message: string } }

		expect(parsed.__filenLog.level).toBe("error")
		expect(parsed.__filenLog.message).toBe("boom 42")
	})

	it("no-ops (does not throw) when ReactNativeWebView is unavailable", async () => {
		const { installDomConsoleProxy } = await import("@/hooks/useDomEvents/domConsoleProxy")

		expect(() => installDomConsoleProxy()).not.toThrow()
	})
})
