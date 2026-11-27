import { beforeEach, describe, expect, it, vi } from "vitest"
import { onlineManager } from "@tanstack/react-query"
import type { Dir, File, NormalDirsAndFiles, UuidStr } from "@filen/sdk-rs"

const { listDirectory } = vi.hoisted(() => ({
	listDirectory: vi.fn<(target: unknown) => Promise<NormalDirsAndFiles>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { listDirectory } }))

vi.mock("@/queries/client", async () => ({ queryClient: (await import("@/tests/testQueryClient")).createTestQueryClient() }))

import { queryClient } from "@/queries/client"
import { discardListingPatches, driveListingQueryOptions, queueListingCreate } from "@/features/drive/queries/drive"
import {
	choiceFor,
	findNameConflicts,
	heldNamesOf,
	namesHeldIn,
	primaryChoice,
	resolveNames,
	withClaims,
	type HeldNames
} from "@/features/drive/lib/nameConflicts"
import { claimUploadName, claimedUploadNames, discardUploadClaims } from "@/features/drive/lib/uploadClaims"
import { narrowItem } from "@/features/drive/lib/item"
import { socketAuthenticated } from "@/lib/sdk/socketSession"
import { testUuid } from "@/tests/support/uuid"

function mockFile(name: string, parent: UuidStr): File {
	return {
		uuid: testUuid(`file-${name}-${parent}`),
		stableUUID: undefined,
		parent,
		size: 0n,
		favorited: false,
		region: "",
		bucket: "",
		timestamp: 1_700_000_000_000n,
		chunks: 0n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "text/plain", modified: 1n, size: 0n, key: "k", version: 2 } }
	}
}

function mockDir(name: string, parent: UuidStr): Dir {
	return {
		uuid: testUuid(`dir-${name}-${parent}`),
		parent,
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name } }
	}
}

let dirCounter = 0

function nextDir(): UuidStr {
	dirCounter++

	return testUuid(`conflict-parent${String(dirCounter)}`)
}

function held(entries: Record<string, "file" | "directory">): HeldNames {
	return new Map(Object.entries(entries).map(([key, kind]) => [key, { kind }]))
}

beforeEach(() => {
	queryClient.clear()
	discardListingPatches()
	discardUploadClaims()
	socketAuthenticated()
	onlineManager.setOnline(true)
	listDirectory.mockReset()
})

describe("namesHeldIn", () => {
	it("answers from a listing current under the live socket without a request, its queued creates landed", async () => {
		const dir = nextDir()

		listDirectory.mockResolvedValue({ dirs: [mockDir("Photos", dir)], files: [mockFile("a.txt", dir)] })
		await queryClient.query(driveListingQueryOptions("drive", dir))
		queueListingCreate(dir, narrowItem(mockFile("queued.txt", dir)))

		const names = await namesHeldIn(dir)

		expect(listDirectory).toHaveBeenCalledTimes(1)
		expect([...(names?.keys() ?? [])].sort()).toEqual(["a.txt", "photos", "queued.txt"])
		expect(names?.get("photos")?.kind).toBe("directory")
	})

	it("reads a listing it does not hold once, and keeps it", async () => {
		const dir = nextDir()

		listDirectory.mockResolvedValue({ dirs: [], files: [mockFile(".hidden", dir)] })

		expect((await namesHeldIn(dir))?.has(".hidden")).toBe(true)
		expect((await namesHeldIn(dir))?.has(".hidden")).toBe(true)
		expect(listDirectory).toHaveBeenCalledTimes(1)
	})

	it("is null offline with nothing cached, and never asks", async () => {
		onlineManager.setOnline(false)

		await expect(namesHeldIn(nextDir())).resolves.toBeNull()
		expect(listDirectory).not.toHaveBeenCalled()
	})

	it("falls back to the cached rows when the read fails, null without any", async () => {
		const dir = nextDir()

		listDirectory.mockRejectedValue(new Error("offline"))

		await expect(namesHeldIn(dir)).resolves.toBeNull()
	})
})

describe("findNameConflicts", () => {
	it("finds clashes with held names case-insensitively and across NFC/NFD, hidden names included", () => {
		const conflicts = findNameConflicts(
			[
				{ name: "REPORT.pdf", isDirectory: false },
				{ name: "Café.txt", isDirectory: false },
				{ name: ".env", isDirectory: false },
				{ name: "new.txt", isDirectory: false }
			],
			held({ "report.pdf": "file", "café.txt": "file", ".env": "file" })
		)

		expect(conflicts.map(conflict => conflict.index)).toEqual([0, 1, 2])
		expect(conflicts[0]?.existing).toBe("file")
	})

	it("finds names another upload of this tab still claims", () => {
		const dir = nextDir()
		const release = claimUploadName(dir, "Sending.bin", "file")
		const names = withClaims(new Map(), dir)

		expect(findNameConflicts([{ name: "sending.BIN", isDirectory: false }], names)).toHaveLength(1)

		release()

		expect(claimedUploadNames(dir)).toBeUndefined()
		expect(findNameConflicts([{ name: "sending.BIN", isDirectory: false }], withClaims(new Map(), dir))).toHaveLength(0)
	})

	it("finds duplicates within the batch, the first one free", () => {
		const conflicts = findNameConflicts(
			[
				{ name: "a.txt", isDirectory: false },
				{ name: "A.TXT", isDirectory: false },
				{ name: "dir", isDirectory: true },
				{ name: "Dir", isDirectory: true }
			],
			new Map()
		)

		expect(conflicts).toEqual([
			{ index: 1, name: "A.TXT", isDirectory: false, existing: "file" },
			{ index: 3, name: "Dir", isDirectory: true, existing: "directory" }
		])
	})

	it("does not count a moved item's own row as a clash", () => {
		const dir = nextDir()
		const own = narrowItem(mockFile("a.txt", dir))
		const names = heldNamesOf([own])

		expect(findNameConflicts([{ name: "a.txt", isDirectory: false, uuid: own.data.uuid }], names)).toHaveLength(0)
		expect(findNameConflicts([{ name: "a.txt", isDirectory: false, uuid: "other" }], names)).toHaveLength(1)
	})
})

describe("conflict choices", () => {
	it("offers Replace for a file onto a file, Merge for an uploaded directory onto one, nothing across kinds", () => {
		expect(primaryChoice({ isDirectory: false, existing: "file" }, "upload")).toBe("replace")
		expect(primaryChoice({ isDirectory: false, existing: "file" }, "move")).toBe("replace")
		expect(primaryChoice({ isDirectory: true, existing: "directory" }, "upload")).toBe("merge")
		expect(primaryChoice({ isDirectory: true, existing: "directory" }, "move")).toBeUndefined()
		expect(primaryChoice({ isDirectory: true, existing: "file" }, "upload")).toBeUndefined()
		expect(primaryChoice({ isDirectory: false, existing: "directory" }, "upload")).toBeUndefined()
	})

	it("applies a choice to all as each conflict allows it, keeping both where it can't", () => {
		expect(choiceFor({ isDirectory: true, existing: "directory" }, "upload", "replace")).toBe("merge")
		expect(choiceFor({ isDirectory: false, existing: "directory" }, "upload", "replace")).toBe("keepBoth")
		expect(choiceFor({ isDirectory: false, existing: "file" }, "upload", "skip")).toBe("skip")
	})
})

describe("resolveNames", () => {
	it("keeps, skips and numbers names free of held names and of the batch's own", () => {
		const candidates = [
			{ name: "a.txt", isDirectory: false },
			{ name: "b.txt", isDirectory: false },
			{ name: "a (1).txt", isDirectory: false },
			{ name: "c.txt", isDirectory: false },
			{ name: "A.txt", isDirectory: false }
		]
		const names = held({ "a.txt": "file", "b.txt": "file" })
		const conflicts = findNameConflicts(candidates, names)

		expect(conflicts.map(conflict => conflict.index)).toEqual([0, 1, 4])

		const resolved = resolveNames({
			candidates,
			held: names,
			conflicts,
			answer: { choices: ["keepBoth", "skip", "keepBoth"], nested: "replace" }
		})

		expect(resolved).toEqual([
			{ action: "rename", name: "a (2).txt" },
			{ action: "skip" },
			{ action: "keep", name: "a (1).txt" },
			{ action: "keep", name: "c.txt" },
			{ action: "rename", name: "A (3).txt" }
		])
	})

	it("skips every conflict when the prompt was dismissed", () => {
		const candidates = [
			{ name: "a.txt", isDirectory: false },
			{ name: "b.txt", isDirectory: false }
		]
		const names = held({ "a.txt": "file" })

		expect(resolveNames({ candidates, held: names, conflicts: findNameConflicts(candidates, names), answer: null })).toEqual([
			{ action: "skip" },
			{ action: "keep", name: "b.txt" }
		])
	})
})
