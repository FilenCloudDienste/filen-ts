import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { isSourceReadError } from "@/lib/media/remuxTypes"

// The remux worker's one compile of libopenmpt's wasm, which every module worker instance it starts is handed.

const wasm = readFileSync(new URL("../vendor/libopenmpt/libopenmpt.wasm", import.meta.url))

afterEach(() => {
	vi.unstubAllGlobals()
	vi.resetModules()
})

describe("libopenmpt wasm", () => {
	it("is fetched same-origin and compiled once, for every instance", async () => {
		const fetched: string[] = []

		vi.stubGlobal("self", { location: { href: "https://app.example/workers/remux.js" } })
		vi.stubGlobal("fetch", (url: URL) => {
			fetched.push(url.origin)

			return Promise.resolve(new Response(wasm))
		})

		const { compileLibopenmpt } = await import("@/workers/synth/libopenmptWasm")
		const first = await compileLibopenmpt()

		expect(first).toBeInstanceOf(WebAssembly.Module)
		expect(await compileLibopenmpt()).toBe(first)
		expect(fetched).toEqual(["https://app.example"])
	})

	it("fails as a read failure, and is fetched again by the next module", async () => {
		let answers = 0

		vi.stubGlobal("self", { location: { href: "https://app.example/workers/remux.js" } })
		vi.stubGlobal("fetch", () => {
			answers++

			return Promise.resolve(answers === 1 ? new Response(null, { status: 503 }) : new Response(wasm))
		})

		const { compileLibopenmpt } = await import("@/workers/synth/libopenmptWasm")

		await expect(compileLibopenmpt()).rejects.toSatisfy(isSourceReadError)
		await expect(compileLibopenmpt()).resolves.toBeInstanceOf(WebAssembly.Module)
		expect(answers).toBe(2)
	})
})
