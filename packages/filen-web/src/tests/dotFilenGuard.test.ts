// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import type { Dir, File } from "@filen/sdk-rs"
import { narrowItem } from "@/features/drive/lib/item"
import { testUuid } from "@/tests/support/uuid"

const ROOT = testUuid("root")

const known = vi.hoisted(() => ({ uuid: null as string | null }))

vi.mock("@/queries/account", () => ({ accountQueryGet: () => ({ rootDirUuid: ROOT }) }))
vi.mock("@/lib/dotFilen", () => ({ knownDotFilenUuid: () => known.uuid }))

const { confirmDotFilenOperation, disposalOperation, includesRootDotFilen, isRootDotFilenItem, useDotFilenAsk } =
	await import("@/features/drive/lib/dotFilenGuard")
const { renderHook, act } = await import("@testing-library/react")

function dir(label: string, name: string, parent: Dir["parent"] = ROOT) {
	return narrowItem({
		uuid: testUuid(label),
		parent,
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name } }
	} satisfies Dir)
}

function file(name: string) {
	return narrowItem({
		uuid: testUuid("file"),
		stableUUID: undefined,
		parent: ROOT,
		size: 1n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "text/plain", size: 1n, key: "k", version: 2 } }
	} as unknown as File)
}

describe("isRootDotFilenItem", () => {
	it("matches the .filen directory directly under the drive root, in any case", () => {
		expect(isRootDotFilenItem(dir("a", ".filen"))).toBe(true)
		expect(isRootDotFilenItem(dir("b", ".FILEN"))).toBe(true)
	})

	it("matches a trashed .filen, whose parent no longer names the root", () => {
		expect(isRootDotFilenItem(dir("t", ".filen", "trash"))).toBe(true)
		expect(isRootDotFilenItem(dir("u", "Docs", "trash"))).toBe(false)
	})

	it("matches the uuid the resolver holds, wherever the directory now sits", () => {
		known.uuid = testUuid("moved")

		expect(isRootDotFilenItem(dir("moved", "settings", testUuid("docs")))).toBe(true)

		known.uuid = null
	})

	it("ignores a nested .filen, a file named .filen and other directories", () => {
		expect(isRootDotFilenItem(dir("c", ".filen", testUuid("docs")))).toBe(false)
		expect(isRootDotFilenItem(file(".filen"))).toBe(false)
		expect(isRootDotFilenItem(dir("d", "Docs"))).toBe(false)
	})
})

describe("confirmDotFilenOperation", () => {
	it("goes on without asking when the items hold no root .filen", async () => {
		const { result } = renderHook(() => useDotFilenAsk())

		await expect(confirmDotFilenOperation("move", [dir("e", "Docs")])).resolves.toBe(true)
		expect(result.current).toBeNull()
	})

	it("asks, one prompt at a time, and answers with the user's choice", async () => {
		const { result } = renderHook(() => useDotFilenAsk())
		const dotFilen = dir("f", ".filen")
		const first = confirmDotFilenOperation("move", [dotFilen, dir("g", "Docs")])
		const second = confirmDotFilenOperation("move", [dotFilen])

		expect(includesRootDotFilen([dotFilen])).toBe(true)
		await vi.waitFor(() => {
			expect(result.current).toMatchObject({ operation: "move", multiple: true })
		})

		act(() => {
			result.current?.settle(false)
		})
		await expect(first).resolves.toBe(false)

		await vi.waitFor(() => {
			expect(result.current).toMatchObject({ operation: "move", multiple: false })
		})

		act(() => {
			result.current?.settle(true)
		})
		await expect(second).resolves.toBe(true)
		expect(result.current).toBeNull()
	})
})

describe("disposalOperation", () => {
	it("names a job's removal of its sources as the operation it amounts to", () => {
		expect(disposalOperation("trash")).toBe("trash")
		expect(disposalOperation("deletePermanently")).toBe("delete")
	})
})
