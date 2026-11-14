import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The engine's wasm ahead of its first use: an explicit prefetch (a tool hovered, print) always compiles; a view's
// idle prefetch compiles on a desktop, only fills the HTTP cache on a phone or tablet, and fetches nothing when the
// user asked to save data.

const IPHONE =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"

interface Fetched {
	readonly url: string
	readonly init: RequestInit | undefined
}

let fetched: Fetched[] = []
const compileStreaming = vi.fn(() => Promise.resolve({} as WebAssembly.Module))

function device(userAgent: string, saveData = false): void {
	vi.stubGlobal("navigator", { userAgent, maxTouchPoints: 0, connection: { saveData } })
}

async function engineModule(): Promise<typeof import("@/features/pdf/session/engineModule")> {
	vi.resetModules()

	return import("@/features/pdf/session/engineModule")
}

async function flush(): Promise<void> {
	for (let k = 0; k < 5; k++) await new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => {
	fetched = []
	vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
		fetched.push({ url, init })

		return Promise.resolve(new Response(new Uint8Array(16), { headers: { "content-type": "application/wasm" } }))
	})
	vi.spyOn(WebAssembly, "compileStreaming").mockImplementation(compileStreaming)
})

afterEach(() => {
	compileStreaming.mockClear()
})

describe("the PDF engine's prefetch", () => {
	it("compiles the module while a desktop view is idle", async () => {
		device(DESKTOP)

		const { prefetchPdfEngineIdle } = await engineModule()

		prefetchPdfEngineIdle()
		await flush()

		expect(compileStreaming).toHaveBeenCalledTimes(1)
		expect(fetched).toHaveLength(1)
	})

	it("only fills the HTTP cache at low priority while a phone's view is idle", async () => {
		device(IPHONE)

		const { prefetchPdfEngineIdle } = await engineModule()

		prefetchPdfEngineIdle()
		prefetchPdfEngineIdle()
		await flush()

		expect(compileStreaming).not.toHaveBeenCalled()
		expect(fetched).toHaveLength(1)
		expect(fetched[0]?.init?.priority).toBe("low")
	})

	it("fetches nothing while idle when the user asked to save data", async () => {
		device(DESKTOP, true)

		const { prefetchPdfEngineIdle } = await engineModule()

		prefetchPdfEngineIdle()
		await flush()

		expect(fetched).toHaveLength(0)
		expect(compileStreaming).not.toHaveBeenCalled()
	})

	it("compiles on an explicit prefetch everywhere, so the first change stays fast", async () => {
		device(IPHONE, true)

		const { prefetchPdfEngine } = await engineModule()

		prefetchPdfEngine()
		await flush()

		expect(compileStreaming).toHaveBeenCalledTimes(1)
	})
})
