import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { transferList } from "@/lib/transferList"

// An office transport's transfer list, checked rather than cast.

function sources(directory: string, into: string[] = []): string[] {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name)

		if (entry.isDirectory()) sources(path, into)
		else if (/\.tsx?$/.test(entry.name)) into.push(path)
	}

	return into
}

describe("transferList", () => {
	it("keeps buffers and ports, in order, and refuses anything else", () => {
		const buffer = new ArrayBuffer(8)
		const { port1 } = new MessageChannel()

		expect(transferList([buffer, port1])).toEqual([buffer, port1])
		expect(transferList([])).toEqual([])
		expect(() => transferList([new Uint8Array(4)])).toThrow(TypeError)
		expect(() => transferList([{}])).toThrow(TypeError)
		port1.close()
	})

	it("is what the PDF editor's transports post with (no cast transfer list)", () => {
		const casts = sources(join(process.cwd(), "src/features/pdf")).filter(path =>
			readFileSync(path, "utf8").includes("as Transferable[]")
		)

		expect(casts).toEqual([])
	})
})
