import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The deployment probe every caller shares: one bounded request to index.html, and what the tab does on
// a newer build. The toast, the service worker and the unload guard are faked.
const { toast, busy, desktop } = vi.hoisted(() => ({
	toast: vi.fn(),
	busy: { held: false },
	desktop: { platform: undefined as "darwin" | undefined }
}))

vi.mock("sonner", () => ({ toast }))
vi.mock("@/lib/i18n", () => ({ i18n: { t: (key: string) => key } }))
vi.mock("@/lib/sw/register", () => ({ applyUpdate: vi.fn() }))
vi.mock("@/lib/unloadGuard", () => ({ hasUnloadHold: () => busy.held }))
vi.mock("@/lib/desktop", () => ({ desktopPlatform: () => desktop.platform }))

const { buildDeployment, recoverIfNewerBuild, showUpdateDeferredToast, showUpdateReadyToast, updateToNewerBuild } =
	await import("@/lib/appUpdate")
const { STALE_RELOAD_COOLDOWN_MS } = await import("@/lib/appUpdate.logic")

const RELOAD_AT_KEY = "filen.staleBuildReloadAt"
// How often recoverIfNewerBuild may ask the server.
const CHECK_INTERVAL_MS = 60_000

// The bundle this build runs from, as the deployed index.html names it: the module under test.
const RUNNING_BUNDLE = new URL("../lib/appUpdate.ts", import.meta.url).pathname

function serve(response: () => Promise<Response>): ReturnType<typeof vi.fn> {
	const fetch = vi.fn(response)

	vi.stubGlobal("fetch", fetch)

	return fetch
}

function serveIndex(html: string): ReturnType<typeof vi.fn> {
	return serve(() => Promise.resolve(new Response(html)))
}

const REPLACED_INDEX = `<script src="/assets/index-newer.js"></script>`
const DEPLOYED_INDEX = `<script src="${RUNNING_BUNDLE}"></script>`

// A controlled clock that only moves forward: the throttle in recoverIfNewerBuild is module state, so
// every test starts well past the window the previous one used.
let clock = 1_700_000_000_000
let storage = new Map<string, string>()
let reload = vi.fn()

// Lets a probe that was not awaited (recoverIfNewerBuild) finish before asserting it did nothing.
function settle(): Promise<void> {
	return new Promise(resolve => {
		setTimeout(resolve, 20)
	})
}

beforeEach(() => {
	vi.stubEnv("PROD", true)
	busy.held = false
	desktop.platform = undefined
	toast.mockClear()

	clock += 10 * CHECK_INTERVAL_MS
	vi.spyOn(Date, "now").mockImplementation(() => clock)

	storage = new Map()
	vi.stubGlobal("sessionStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => {
			storage.set(key, value)
		}
	})

	reload = vi.fn()
	vi.stubGlobal("location", { reload })
})

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
})

describe("buildDeployment", () => {
	it("compares the deployed index.html with the running bundle", async () => {
		serveIndex(DEPLOYED_INDEX)

		expect(await buildDeployment()).toBe("deployed")

		serveIndex(REPLACED_INDEX)

		expect(await buildDeployment()).toBe("replaced")
	})

	it("knows nothing from a failed answer, an unreachable server or a dev build", async () => {
		serve(() => Promise.resolve(new Response("", { status: 503 })))

		expect(await buildDeployment()).toBe("unknown")

		serve(() => Promise.reject(new TypeError("Failed to fetch")))

		expect(await buildDeployment()).toBe("unknown")

		vi.stubEnv("PROD", false)

		const fetch = serve(() => Promise.reject(new Error("not asked")))

		expect(await buildDeployment()).toBe("unknown")
		expect(fetch).not.toHaveBeenCalled()
	})

	it("gives up on a request that hangs, rather than holding up what waits on it", async () => {
		const deadline = new AbortController()
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal)

		serve(
			() =>
				new Promise<Response>((_resolve, reject) => {
					deadline.signal.addEventListener("abort", () => {
						reject(new DOMException("timed out", "TimeoutError"))
					})
				})
		)

		const verdict = buildDeployment()

		deadline.abort()

		expect(await verdict).toBe("unknown")
		expect(timeout).toHaveBeenCalledTimes(1)
		expect(timeout.mock.calls[0]?.[0]).toBeLessThanOrEqual(10_000)
	})
})

describe("showUpdateReadyToast", () => {
	it("prompts in a browser", () => {
		showUpdateReadyToast()

		expect(toast).toHaveBeenCalledTimes(1)
	})

	it("never prompts in the desktop app, which updates natively", () => {
		desktop.platform = "darwin"
		showUpdateReadyToast()

		expect(toast).not.toHaveBeenCalled()
	})
})

describe("showUpdateDeferredToast", () => {
	it("replaces the update prompt with a note that stays up and offers no action", () => {
		showUpdateReadyToast()
		showUpdateDeferredToast()

		expect(toast).toHaveBeenCalledTimes(2)

		const [, ready] = toast.mock.calls[0] as [string, { id: string }]
		const [title, deferred] = toast.mock.calls[1] as [string, Record<string, unknown>]

		expect(title).toBe("updateReadyTitle")
		expect(deferred).toEqual({ id: ready.id, description: "updateAfterDownload", duration: Infinity, action: undefined })
		expect("action" in deferred).toBe(true)
	})

	it("never shows in the desktop app, which updates natively", () => {
		desktop.platform = "darwin"
		showUpdateDeferredToast()

		expect(toast).not.toHaveBeenCalled()
	})
})

describe("updateToNewerBuild", () => {
	it("asks first while something holds the tab", () => {
		busy.held = true
		updateToNewerBuild()

		expect(toast).toHaveBeenCalledTimes(1)
		expect(reload).not.toHaveBeenCalled()
	})

	it("reloads an idle tab into the newer build and remembers when", () => {
		updateToNewerBuild()

		expect(reload).toHaveBeenCalledTimes(1)
		expect(toast).not.toHaveBeenCalled()
		expect(storage.get(RELOAD_AT_KEY)).toBe(String(clock))
	})

	it("does not reload again within the cooldown, and does once it has passed", () => {
		updateToNewerBuild()

		clock += STALE_RELOAD_COOLDOWN_MS - 1
		updateToNewerBuild()

		expect(reload).toHaveBeenCalledTimes(1)

		clock += 1
		updateToNewerBuild()

		expect(reload).toHaveBeenCalledTimes(2)
		expect(storage.get(RELOAD_AT_KEY)).toBe(String(clock))
	})
})

describe("recoverIfNewerBuild", () => {
	it("asks the server once within a minute, and prompts a busy tab on a replaced build", async () => {
		busy.held = true

		const fetch = serveIndex(REPLACED_INDEX)

		recoverIfNewerBuild()
		recoverIfNewerBuild()
		await vi.waitFor(() => {
			expect(toast).toHaveBeenCalledTimes(1)
		})

		expect(fetch).toHaveBeenCalledTimes(1)
		expect(reload).not.toHaveBeenCalled()
	})

	it("reloads an idle tab on a replaced build", async () => {
		serveIndex(REPLACED_INDEX)
		recoverIfNewerBuild()
		await vi.waitFor(() => {
			expect(reload).toHaveBeenCalledTimes(1)
		})

		expect(toast).not.toHaveBeenCalled()
	})

	it("leaves the tab as it is while its build is still deployed or the server cannot tell", async () => {
		const deployed = serveIndex(DEPLOYED_INDEX)

		recoverIfNewerBuild()
		await settle()

		expect(deployed).toHaveBeenCalledTimes(1)

		clock += CHECK_INTERVAL_MS

		const failed = serve(() => Promise.resolve(new Response("", { status: 503 })))

		recoverIfNewerBuild()
		await settle()

		expect(failed).toHaveBeenCalledTimes(1)
		expect(toast).not.toHaveBeenCalled()
		expect(reload).not.toHaveBeenCalled()
	})

	it("asks the server again once a minute has passed", async () => {
		const fetch = serveIndex(DEPLOYED_INDEX)

		recoverIfNewerBuild()
		clock += CHECK_INTERVAL_MS - 1
		recoverIfNewerBuild()

		expect(fetch).toHaveBeenCalledTimes(1)

		clock += 1
		recoverIfNewerBuild()

		expect(fetch).toHaveBeenCalledTimes(2)
		await settle()
	})
})
