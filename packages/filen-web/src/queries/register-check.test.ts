import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchRegisterCheck } from "@/queries/register-check"

// global.fetch is the only ambient surface this module touches — replaced wholesale per test,
// mirroring src/lib/sw/register.test.ts's vi.stubGlobal idiom (no DOM lib in this project).
function stubFetch(impl: () => Promise<unknown>): void {
	vi.stubGlobal("fetch", vi.fn(impl))
}

function fakeResponse(body: unknown, ok = true): unknown {
	return { ok, json: () => Promise.resolve(body) }
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("fetchRegisterCheck (fake global fetch)", () => {
	it("returns ok:true for a valid eligible response", async () => {
		stubFetch(() => Promise.resolve(fakeResponse({ status: true, data: { ok: true } })))

		await expect(fetchRegisterCheck()).resolves.toEqual({ ok: true })
	})

	it("returns ok:false for a valid but ineligible response", async () => {
		stubFetch(() => Promise.resolve(fakeResponse({ status: true, data: { ok: false } })))

		await expect(fetchRegisterCheck()).resolves.toEqual({ ok: false })
	})

	it("returns ok:false when status is falsy even with a well-shaped data object", async () => {
		stubFetch(() => Promise.resolve(fakeResponse({ status: false, data: { ok: true } })))

		await expect(fetchRegisterCheck()).resolves.toEqual({ ok: false })
	})

	it("returns ok:false on a non-2xx response", async () => {
		stubFetch(() => Promise.resolve(fakeResponse({}, false)))

		await expect(fetchRegisterCheck()).resolves.toEqual({ ok: false })
	})

	it("returns ok:false on a malformed body", async () => {
		stubFetch(() => Promise.resolve(fakeResponse({ status: true })))

		await expect(fetchRegisterCheck()).resolves.toEqual({ ok: false })
	})

	it("returns ok:false when fetch itself rejects", async () => {
		stubFetch(() => Promise.reject(new Error("network down")))

		await expect(fetchRegisterCheck()).resolves.toEqual({ ok: false })
	})
})
