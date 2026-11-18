import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { classifyResourceUrl, decodeDataUrl, resourceBudget } from "@/lib/workers/resourceSandbox.logic"
import { installResourceSandbox } from "@/lib/workers/resourceSandbox"

const BASE = "https://app.example/assets/model3d.worker.js"
const ASSETS = ["/assets/three/"]

describe("classifyResourceUrl", () => {
	it.each([
		["blob:https://app.example/1234", "blob"],
		["data:text/plain,hi", "data"],
		["filen-ref:///textures/wood.png", "ref"],
		["/assets/three/draco.wasm", "asset"],
		["three/draco.wasm", "asset"],
		["https://app.example/api/user", "external"],
		["https://cdn.example/assets/three/x.wasm", "external"],
		["ftp://app.example/assets/three/x", "external"],
		["http://[broken", "external"]
	])("%s -> %s", (url, kind) => {
		expect(classifyResourceUrl(url, BASE, ASSETS).kind).toBe(kind)
	})

	it.each([
		// The 3D decoders and the CAD viewer's fonts, root-relative as the build writes them.
		["/assets/three/draco.wasm", "asset"],
		["filen://app/assets/three/draco.wasm", "asset"],
		["/assets/office-fonts/arimo/Arimo-Regular.ttf-2096961b.gz", "asset"],
		["/api/user", "external"],
		["filen://other/assets/three/draco.wasm", "external"],
		["https://app/assets/three/draco.wasm", "external"],
		["filen-desktop://app/assets/three/draco.wasm", "external"]
	])("on the desktop app's filen://app origin, %s -> %s", (url, kind) => {
		const assets = [...ASSETS, "/assets/office-fonts/arimo/Arimo-Regular.ttf-2096961b.gz"]

		expect(classifyResourceUrl(url, "filen://app/assets/dxf.worker.js", assets).kind).toBe(kind)
	})

	it("hands a reference's path over still encoded and without its leading slashes", () => {
		expect(classifyResourceUrl("filen-ref:///sub%20dir/a.png", BASE, ASSETS)).toEqual({ kind: "ref", path: "sub%20dir/a.png" })
	})

	it("hands `..`, `#` and `?` over as written, for the resolver to refuse or find", () => {
		expect(classifyResourceUrl("filen-ref:///../../etc/x", BASE, ASSETS)).toEqual({ kind: "ref", path: "../../etc/x" })
		expect(classifyResourceUrl("filen-ref:///maps/a#1.png", BASE, ASSETS)).toEqual({ kind: "ref", path: "maps/a#1.png" })
		expect(classifyResourceUrl("filen-ref:///x?.png", BASE, ASSETS)).toEqual({ kind: "ref", path: "x?.png" })
	})
})

describe("decodeDataUrl", () => {
	it("decodes base64 and percent-encoded bodies", () => {
		expect(decodeDataUrl("data:application/octet-stream;base64,AAEC/w==", 100)).toEqual({
			status: "ok",
			bytes: new Uint8Array([0, 1, 2, 255]),
			type: "application/octet-stream"
		})
		expect(decodeDataUrl("data:,a%20b%ffc%zz", 100)).toEqual({
			status: "ok",
			bytes: new Uint8Array([0x61, 0x20, 0x62, 0xff, 0x63, 0x25, 0x7a, 0x7a]),
			type: "text/plain;charset=US-ASCII"
		})
	})

	it("refuses a body over the cap before decoding it", () => {
		expect(decodeDataUrl(`data:;base64,${"A".repeat(16)}`, 11)).toEqual({ status: "overBudget" })
		expect(decodeDataUrl(`data:;base64,${"A".repeat(16)}`, 12).status).toBe("ok")
		expect(decodeDataUrl("data:,abcdef", 5)).toEqual({ status: "overBudget" })
	})

	it("reports a malformed URL", () => {
		expect(decodeDataUrl("data:no-comma", 100)).toEqual({ status: "malformed" })
		expect(decodeDataUrl("data:;base64,@@@", 100)).toEqual({ status: "malformed" })
	})
})

describe("resourceBudget", () => {
	it("takes only what fits and gets bytes back", () => {
		const budget = resourceBudget(10)

		expect(budget.take(6)).toBe(true)
		expect(budget.take(5)).toBe(false)
		expect(budget.remaining).toBe(4)

		budget.give(6)

		expect(budget.take(10)).toBe(true)
	})
})

describe("installResourceSandbox", () => {
	const saved = {
		fetch: globalThis.fetch,
		Request: globalThis.Request,
		create: URL.createObjectURL.bind(URL),
		revoke: URL.revokeObjectURL.bind(URL),
		XMLHttpRequest: (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest,
		WebSocket: globalThis.WebSocket,
		EventSource: (globalThis as { EventSource?: unknown }).EventSource
	}
	const realFetch = vi.fn((_input: RequestInfo | URL) => Promise.resolve(new Response("asset")))

	beforeEach(() => {
		globalThis.fetch = realFetch
		vi.stubGlobal("location", new URL(BASE))
	})

	afterEach(() => {
		globalThis.fetch = saved.fetch
		globalThis.Request = saved.Request
		URL.createObjectURL = saved.create
		URL.revokeObjectURL = saved.revoke
		Object.assign(globalThis, { XMLHttpRequest: saved.XMLHttpRequest, WebSocket: saved.WebSocket, EventSource: saved.EventSource })
		vi.unstubAllGlobals()
		realFetch.mockClear()
	})

	function install(budget = 1000, resolve = (_path: string) => Promise.resolve<Blob | null>(null)) {
		return installResourceSandbox({ assets: ASSETS, resolve, budget })
	}

	it("serves a blob the worker registered, and only while registered", async () => {
		install()

		const url = URL.createObjectURL(new Blob(["mesh"]))

		await expect((await fetch(url)).text()).resolves.toBe("mesh")

		URL.revokeObjectURL(url)

		await expect(fetch(url)).rejects.toMatchObject({ name: "ExternalReferenceBlocked" })
	})

	it("counts registered blobs against the budget and refunds them on revoke", () => {
		install(10)

		const url = URL.createObjectURL(new Blob(["12345678"]))

		expect(() => URL.createObjectURL(new Blob(["123"]))).toThrow(expect.objectContaining({ name: "ResourceBudgetExceeded" }))

		URL.revokeObjectURL(url)

		expect(() => URL.createObjectURL(new Blob(["123"]))).not.toThrow()
	})

	it("decodes data: URLs locally under the budget", async () => {
		install(4)

		const response = await fetch("data:image/png;base64,AAEC")

		expect(response.headers.get("Content-Type")).toBe("image/png")
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2]))
		await expect(fetch("data:;base64,AAEC")).rejects.toMatchObject({ name: "ResourceBudgetExceeded" })
	})

	it("resolves references, 404s a missing one, and charges the budget", async () => {
		const resolve = vi.fn((path: string) => Promise.resolve(path === "tex.png" ? new Blob(["pixels"]) : null))

		install(10, resolve)

		await expect((await fetch("filen-ref:///tex.png")).text()).resolves.toBe("pixels")
		expect((await fetch("filen-ref:///missing.png")).status).toBe(404)
		await expect(fetch("filen-ref:///tex.png")).rejects.toMatchObject({ name: "ResourceBudgetExceeded" })
	})

	it("resolves a reference fetched through a Request by the string it was built from", async () => {
		const resolve = vi.fn((path: string) => Promise.resolve(path === "../a#1.png" ? new Blob(["x"]) : null))

		install(10, resolve)

		await expect((await fetch(new Request("filen-ref:///../a#1.png"))).text()).resolves.toBe("x")
		expect(resolve).toHaveBeenCalledWith("../a#1.png")
	})

	it("passes same-origin assets to the real fetch and refuses everything else, counting it", async () => {
		const sandbox = install()

		await expect((await fetch("/assets/three/basis.wasm")).text()).resolves.toBe("asset")
		expect(realFetch).toHaveBeenCalledTimes(1)

		await expect(fetch("https://tracker.example/pixel.gif")).rejects.toMatchObject({ name: "ExternalReferenceBlocked" })
		await expect(fetch(new Request("https://app.example/api/v3/user"))).rejects.toMatchObject({ name: "ExternalReferenceBlocked" })
		expect(realFetch).toHaveBeenCalledTimes(1)
		expect(sandbox.blocked()).toBe(2)
	})

	it("makes XMLHttpRequest, WebSocket and EventSource throw", () => {
		const sandbox = install()
		const scope = globalThis as unknown as Record<"XMLHttpRequest" | "WebSocket" | "EventSource", new (url?: string) => unknown>

		expect(() => new scope.XMLHttpRequest()).toThrow("external reference blocked")
		expect(() => new scope.WebSocket("wss://x.example")).toThrow("external reference blocked")
		expect(() => new scope.EventSource("https://x.example")).toThrow("external reference blocked")
		expect(sandbox.blocked()).toBe(3)
	})

	it("honours an aborted signal", async () => {
		install()

		await expect(fetch("data:,x", { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" })
	})
})
