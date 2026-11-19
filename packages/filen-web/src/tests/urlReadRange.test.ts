import { afterEach, describe, expect, it, vi } from "vitest"
import { urlReadRange } from "@/lib/media/urlReadRange"

// A Range read against the service worker's preview route: only a 206 is an answer.

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("urlReadRange", () => {
	it("returns the bytes of a 206 and asks for an inclusive range", async () => {
		const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
			Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 206 }))
		)

		vi.stubGlobal("fetch", fetchMock)

		const bytes = await urlReadRange("/preview/abc")(10, 13)

		expect(Array.from(bytes)).toEqual([1, 2, 3])
		expect(fetchMock).toHaveBeenCalledWith("/preview/abc", { headers: { Range: "bytes=10-12" } })
	})

	it("cancels the body of a 200 and rejects without reading it", async () => {
		const cancel = vi.fn()
		const body = new ReadableStream<Uint8Array>({ cancel })
		const response = new Response(body, { status: 200 })
		const arrayBuffer = vi.spyOn(response, "arrayBuffer")

		vi.stubGlobal("fetch", () => Promise.resolve(response))

		await expect(urlReadRange("/preview/abc")(0, 100)).rejects.toThrow("range read answered 200")
		expect(cancel).toHaveBeenCalledTimes(1)
		expect(arrayBuffer).not.toHaveBeenCalled()
	})
})
