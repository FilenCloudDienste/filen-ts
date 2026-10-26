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

const { buildDeployment, recoverIfNewerBuild, showUpdateReadyToast, updateToNewerBuild } = await import("@/lib/appUpdate")

// The bundle this build runs from, as the deployed index.html names it: the module under test.
const RUNNING_BUNDLE = new URL("../lib/appUpdate.ts", import.meta.url).pathname

function serve(response: () => Promise<Response>): ReturnType<typeof vi.fn> {
	const fetch = vi.fn(response)

	vi.stubGlobal("fetch", fetch)

	return fetch
}

beforeEach(() => {
	vi.stubEnv("PROD", true)
	busy.held = false
	desktop.platform = undefined
	toast.mockClear()
})

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
})

describe("buildDeployment", () => {
	it("compares the deployed index.html with the running bundle", async () => {
		serve(() => Promise.resolve(new Response(`<script src="${RUNNING_BUNDLE}"></script>`)))

		expect(await buildDeployment()).toBe("deployed")

		serve(() => Promise.resolve(new Response(`<script src="/assets/index-newer.js"></script>`)))

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

describe("updateToNewerBuild", () => {
	it("asks first while something holds the tab", () => {
		busy.held = true
		updateToNewerBuild()

		expect(toast).toHaveBeenCalledTimes(1)
	})
})

describe("recoverIfNewerBuild", () => {
	it("asks the server once per minute, and updates only from a replaced build", async () => {
		busy.held = true

		const fetch = serve(() => Promise.resolve(new Response(`<script src="/assets/index-newer.js"></script>`)))

		recoverIfNewerBuild()
		recoverIfNewerBuild()
		await vi.waitFor(() => {
			expect(toast).toHaveBeenCalledTimes(1)
		})

		expect(fetch).toHaveBeenCalledTimes(1)
	})
})
