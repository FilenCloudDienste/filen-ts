import { vi, describe, it, expect, beforeEach } from "vitest"

// The query module imports @/lib/logger (→ storageRoots → expo-file-system), which throws in the
// node test env — mock it with the shared no-op logger. Nothing else is imported by the module.
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

import { fetchData } from "@/features/auth/queries/useRegisterCheck.query"

// Minimal Response-like stub: only .ok and .json() are read by fetchData.
function jsonResponse(body: unknown, ok = true): Response {
	return {
		ok,
		status: ok ? 200 : 500,
		json: async () => body
	} as unknown as Response
}

describe("fetchData (useRegisterCheck)", () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	it("returns { ok: true } for a valid eligible response", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ status: true, data: { ok: true } })))

		const result = await fetchData()

		expect(result).toEqual({ ok: true })
	})

	it("returns { ok: false } for a valid not-eligible response", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ status: true, data: { ok: false } })))

		const result = await fetchData()

		expect(result).toEqual({ ok: false })
	})

	it("returns { ok: false } when the HTTP response is not ok (e.g. 500)", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ status: true, data: { ok: true } }, false)))

		const result = await fetchData()

		expect(result).toEqual({ ok: false })
	})

	it("returns { ok: false } for a malformed body (falsy status / missing data)", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ status: false })))

		const result = await fetchData()

		expect(result).toEqual({ ok: false })
	})

	it("returns { ok: false } when fetch rejects (network error) — never throws", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")))

		const result = await fetchData()

		expect(result).toEqual({ ok: false })
	})

	it("maps a defined-but-non-boolean ok strictly to false (=== true)", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ status: true, data: { ok: "yes" } })))

		const result = await fetchData()

		expect(result).toEqual({ ok: false })
	})
})
