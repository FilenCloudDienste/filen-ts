import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Remote } from "comlink"
import type { SdkWorkerApi } from "@/workers/sdk.worker"

// api.boot against a stubbed wasm module and fetch: the preflight overlaps init, but its verdict
// (first failing artifact in declaration order) still decides the result.
const { exposed, init, initThreadPool } = vi.hoisted(() => ({
	exposed: new Map<"api", unknown>(),
	init: vi.fn<() => Promise<void>>(),
	initThreadPool: vi.fn<(threads: number) => Promise<void>>()
}))

vi.mock("@filen/sdk-rs", () => ({
	default: init,
	initThreadPool,
	UnauthClient: { from_config: () => ({ free: vi.fn() }) }
}))

vi.mock("comlink", () => ({
	expose: (api: unknown) => {
		exposed.set("api", api)
	},
	proxy: (value: unknown) => value,
	transfer: (value: unknown) => value
}))

await import("@/workers/sdk.worker")

const api = exposed.get("api") as Remote<SdkWorkerApi>

const BASE = "https://app.test/assets/"

function stubHeads(statusFor: (name: string) => number | Error): string[] {
	const requested: string[] = []
	vi.stubGlobal(
		"fetch",
		vi.fn((url: URL, initArg: RequestInit) => {
			expect(initArg.method).toBe("HEAD")
			const name = url.href.slice(BASE.length)
			requested.push(name)
			const status = statusFor(name)
			return status instanceof Error ? Promise.reject(status) : Promise.resolve(new Response(null, { status }))
		})
	)
	return requested
}

describe("sdk worker boot", () => {
	beforeEach(() => {
		vi.stubGlobal("self", { location: { href: `${BASE}sdk.worker.js` }, crossOriginIsolated: true })
		init.mockResolvedValue(undefined)
		initThreadPool.mockResolvedValue(undefined)
	})

	it("boots when every artifact is present, starting init before the preflight settles", async () => {
		let releaseHeads: () => void = () => undefined
		const gate = new Promise<void>(resolve => {
			releaseHeads = resolve
		})
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				await gate
				return new Response(null, { status: 200 })
			})
		)
		const booting = api.boot({ threads: 4 })
		await Promise.resolve()
		expect(init).toHaveBeenCalledTimes(1)
		expect(init.mock.calls[0]).toEqual([{ module_or_path: new URL("sdk-rs_bg.wasm", `${BASE}sdk.worker.js`) }])
		expect(initThreadPool).not.toHaveBeenCalled()
		releaseHeads()
		await expect(booting).resolves.toEqual({ ok: true, threads: 4 })
		expect(initThreadPool).toHaveBeenCalledWith(4)
	})

	it("reports the first failing artifact in declaration order", async () => {
		const requested = stubHeads(name => (name === "filen-sdk-worker-thread.js" ? 200 : 404))
		await expect(api.boot({ threads: 2 })).resolves.toEqual({ ok: false, reason: "artifacts", detail: "sdk-rs.js: HTTP 404" })
		expect(requested.sort()).toEqual(["filen-sdk-worker-thread.js", "sdk-rs.js", "sdk-rs_bg.wasm"])
		expect(initThreadPool).not.toHaveBeenCalled()
	})

	it("prefers the preflight verdict over a concurrent init rejection", async () => {
		const unhandled = vi.fn()
		process.on("unhandledRejection", unhandled)
		init.mockRejectedValue(new Error("wasm 404"))
		stubHeads(name => (name === "sdk-rs_bg.wasm" ? new Error("offline") : 200))
		const result = await api.boot({ threads: 2 })
		expect(result).toMatchObject({ ok: false, reason: "artifacts" })
		expect(result.ok ? "" : result.detail).toMatch(/^sdk-rs_bg\.wasm: /)
		await new Promise(resolve => setTimeout(resolve, 0))
		process.off("unhandledRejection", unhandled)
		expect(unhandled).not.toHaveBeenCalled()
	})

	it("surfaces an init rejection when the preflight passes", async () => {
		init.mockRejectedValue(new Error("instantiate failed"))
		stubHeads(() => 200)
		await expect(api.boot({ threads: 2 })).rejects.toThrow("instantiate failed")
		expect(initThreadPool).not.toHaveBeenCalled()
	})

	it("reports a missing cross-origin isolation after init", async () => {
		vi.stubGlobal("self", { location: { href: `${BASE}sdk.worker.js` }, crossOriginIsolated: false })
		stubHeads(() => 200)
		await expect(api.boot({ threads: 2 })).resolves.toEqual({ ok: false, reason: "coi", detail: "crossOriginIsolated=false" })
		expect(init).toHaveBeenCalledTimes(1)
	})
})
