import { describe, expect, it } from "vitest"
import { createMemorySink, toRawPreviewResult } from "@/features/preview/lib/rawPreview.logic"

describe("createMemorySink", () => {
	it("collects every written chunk in order", async () => {
		const { writer, chunks } = createMemorySink()
		const w = writer.getWriter()

		await w.write(new Uint8Array([1, 2]))
		await w.write(new Uint8Array([3]))
		await w.close()

		expect(chunks.map(chunk => Array.from(chunk))).toEqual([[1, 2], [3]])
	})

	// A chunk may be a view onto memory the producer reuses once write() returns; the sink must own
	// its bytes, not the view.
	it("copies each chunk rather than keeping the producer's view", async () => {
		const { writer, chunks } = createMemorySink()
		const w = writer.getWriter()
		const reused = new Uint8Array([9, 9, 9])

		await w.write(reused)
		reused.fill(0)
		await w.close()

		expect(Array.from(chunks[0] ?? [])).toEqual([9, 9, 9])
	})
})

describe("toRawPreviewResult", () => {
	it("passes a noPreview verdict through, whatever was written", () => {
		expect(toRawPreviewResult({ type: "noPreview" }, [])).toEqual({ type: "noPreview" })
	})

	it("assembles the written chunks into one JPEG blob", async () => {
		const result = toRawPreviewResult({ type: "preview", width: 1936, height: 1288, orientation: 1, bytes: 5n }, [
			new Uint8Array([0xff, 0xd8, 0xff]),
			new Uint8Array([0xd9, 0x00])
		])

		expect(result.type).toBe("preview")

		if (result.type !== "preview") {
			return
		}

		expect(result.blob.type).toBe("image/jpeg")
		expect(Array.from(new Uint8Array(await result.blob.arrayBuffer()))).toEqual([0xff, 0xd8, 0xff, 0xd9, 0x00])
	})

	it("rejects a preview whose written bytes do not match the SDK's own count", () => {
		expect(() =>
			toRawPreviewResult({ type: "preview", width: 1, height: 1, orientation: 1, bytes: 10n }, [new Uint8Array([1])])
		).toThrow(/size mismatch/)
	})

	it("rejects an empty preview", () => {
		expect(() => toRawPreviewResult({ type: "preview", width: 1, height: 1, orientation: 1, bytes: 0n }, [])).toThrow(/size mismatch/)
	})
})
