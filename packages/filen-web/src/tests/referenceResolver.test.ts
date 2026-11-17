import { describe, expect, it, vi } from "vitest"
import {
	MAX_REFERENCES,
	nameKey,
	onceEach,
	referenceSegments,
	referenceWalker,
	type ReferenceListing
} from "@/features/preview/lib/referenceResolver.logic"

interface Dir {
	readonly id: string
}

describe("referenceSegments", () => {
	it("decodes, reads backslashes as slashes and collapses dot segments", () => {
		expect(referenceSegments("tex.png")).toEqual(["tex.png"])
		expect(referenceSegments("textures%2Fwood%20oak.png")).toEqual(["textures", "wood oak.png"])
		expect(referenceSegments("textures\\wood.png")).toEqual(["textures", "wood.png"])
		expect(referenceSegments("./a/./b/../c.png")).toEqual(["a", "c.png"])
		// Not percent-encoding after all: taken as written.
		expect(referenceSegments("100%.png")).toEqual(["100%.png"])
	})

	it("refuses a path that climbs above the model's directory, or names nothing", () => {
		expect(referenceSegments("../tex.png")).toBeNull()
		expect(referenceSegments("a/../../tex.png")).toBeNull()
		expect(referenceSegments("%2E%2E/tex.png")).toBeNull()
		expect(referenceSegments("")).toBeNull()
		expect(referenceSegments("./")).toBeNull()
	})

	it("reads an absolute path from the exporting machine as its base name", () => {
		expect(referenceSegments("C:\\Users\\me\\Desktop\\tex.png")).toEqual(["tex.png"])
		expect(referenceSegments("/home/me/tex.png")).toEqual(["tex.png"])
		expect(referenceSegments("file:///home/me/tex.png")).toEqual(["tex.png"])
		expect(referenceSegments("/home/me/..")).toBeNull()
	})

	it("compares names case-insensitively in one Unicode form", () => {
		expect(nameKey("Tex.PNG")).toBe(nameKey("tex.png"))
		expect(nameKey("Cafe\u0301.png")).toBe(nameKey("café.png"))
	})
})

describe("referenceWalker", () => {
	const listings: Record<string, ReferenceListing<Dir, string>> = {
		root: {
			dirs: [
				["Textures", { id: "textures" }],
				["textures", { id: "shadowed" }]
			],
			files: [
				["mesh.mtl", "mtl"],
				["member.png", null]
			]
		},
		textures: { dirs: [["deep", { id: "deep" }]], files: [["Wood.PNG", "wood"]] },
		deep: { dirs: [], files: [["x.png", "x"]] }
	}

	function walker() {
		const root = vi.fn(() => Promise.resolve(listings["root"] ?? { dirs: [], files: [] }))
		const child = vi.fn((dir: Dir) => Promise.resolve(listings[dir.id] ?? { dirs: [], files: [] }))

		return { root, child, lookup: referenceWalker(root, child) }
	}

	it("finds files in the model's directory and below it, whatever their case", async () => {
		const { lookup } = walker()

		expect(await lookup("mesh.mtl")).toEqual({ status: "found", file: "mtl" })
		expect(await lookup("textures/wood.png")).toEqual({ status: "found", file: "wood" })
		expect(await lookup("TEXTURES\\deep\\X.png")).toEqual({ status: "found", file: "x" })
	})

	it("tells a missing file, one not readable on its own, and one above the directory apart", async () => {
		const { lookup, child } = walker()

		expect(await lookup("nothing.png")).toEqual({ status: "missing" })
		expect(await lookup("nowhere/x.png")).toEqual({ status: "missing" })
		expect(await lookup("member.png")).toEqual({ status: "unreadable" })
		expect(await lookup("../mesh.mtl")).toEqual({ status: "refused" })
		// No directory named "nowhere": nothing was listed for it.
		expect(child).not.toHaveBeenCalled()
	})

	it("lists each directory once, and only when a reference names it", async () => {
		const { lookup, root, child } = walker()

		await Promise.all([lookup("textures/wood.png"), lookup("textures/a.png"), lookup("Textures/deep/x.png"), lookup("mesh.mtl")])

		expect(root).toHaveBeenCalledTimes(1)
		expect(child.mock.calls.map(([dir]) => dir.id)).toEqual(["textures", "deep"])
	})

	it("reads a listing that failed as an empty one", async () => {
		const lookup = referenceWalker<Dir, string>(
			() => Promise.reject(new Error("offline")),
			() => Promise.reject(new Error("offline"))
		)

		expect(await lookup("mesh.mtl")).toEqual({ status: "missing" })
	})
})

describe("onceEach", () => {
	it("asks once per file however it is spelled, and only counts the files past the limit", async () => {
		const ask = vi.fn((path: string) => Promise.resolve(path))
		const references = onceEach(ask)

		expect(await Promise.all(["a/B.png", "./a/b.png", "a%2Fb.png"].map(references.ask))).toEqual(["a/B.png", "a/B.png", "a/B.png"])
		expect(ask).toHaveBeenCalledOnce()

		for (let i = 0; i < MAX_REFERENCES + 4; i++) await references.ask(`x${String(i)}.png`)

		expect(ask).toHaveBeenCalledTimes(MAX_REFERENCES)
		expect(references.unlisted()).toBe(5)
	})
})
