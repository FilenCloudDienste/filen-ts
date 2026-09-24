import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Dir, File, FileMeta, FileVersion, SocketEvent, UserInfo, UuidStr } from "@filen/sdk-rs"

// A clipboard entry is a snapshot of the items at Copy/Cut time; this pins what keeps it current. Events
// go in through the real drive socket handler and writes through the real drive actions, so the wiring is
// covered along with the mapping.

const { performMove, startCopyWithCard, renameFile, moveFile, trashFile, deleteFilePermanently, setDirectoryColor, restoreFileVersionOp } =
	vi.hoisted(() => ({
		performMove: vi.fn(),
		startCopyWithCard: vi.fn(),
		renameFile: vi.fn(),
		moveFile: vi.fn(),
		trashFile: vi.fn(),
		deleteFilePermanently: vi.fn(),
		setDirectoryColor: vi.fn(),
		restoreFileVersionOp: vi.fn()
	}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { renameFile, moveFile, trashFile, deleteFilePermanently, setDirectoryColor, restoreFileVersionOp }
}))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock("@/features/drive/lib/dnd", () => ({ performMove }))
vi.mock("@/features/transfers/lib/copyToast", () => ({ startCopyWithCard }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import "@/lib/i18n"
import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { handleDriveEvent } from "@/features/drive/lib/socketHandlers"
import { deleteItemsPermanently, moveItems, renameItem, restoreVersion, setColor, trashItems } from "@/features/drive/lib/actions"
import { followClipboardItem } from "@/features/drive/lib/clipboardSync"
import { copyToClipboard, cutToClipboard, pasteClipboard } from "@/features/drive/lib/clipboard"
import { useDriveClipboardStore } from "@/features/drive/store/useDriveClipboardStore"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

const HOME = testUuid("home")
const ELSEWHERE = testUuid("elsewhere")
const STABLE = testUuid("stable")
const DESTINATION = { uuid: testUuid("dest"), name: "dest" }

function fileMeta(name: string): FileMeta {
	return { type: "decoded", data: { name, mime: "text/plain", modified: 0n, size: 1n, key: "key", version: 2 } }
}

function rawFile(uuid: string, overrides: Partial<File> = {}): File {
	return {
		uuid: testUuid(uuid),
		stableUUID: STABLE,
		parent: HOME,
		size: 1n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: fileMeta("a.txt"),
		...overrides
	}
}

function rawDir(uuid: string, overrides: Partial<Dir> = {}): Dir {
	return {
		uuid: testUuid(uuid),
		parent: HOME,
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name: uuid } },
		...overrides
	}
}

// U1 is the file as it was cut or copied; a content save makes U2, keeping its stable id.
const U1 = narrowItem(rawFile("u1"))
const DOCS = narrowItem(rawDir("docs"))

function drive(inner: Extract<SocketEvent, { type: "drive" }>["inner"]): void {
	handleDriveEvent({ type: "drive", inner, driveMessageId: 0n })
}

function entry() {
	return useDriveClipboardStore.getState().entry
}

function names(): (string | undefined)[] {
	return entry()?.items.map(item => item.data.decryptedMeta?.name) ?? []
}

function uuids(): string[] {
	return entry()?.items.map(item => item.data.uuid) ?? []
}

beforeEach(() => {
	queryClient.clear()
	queryClient.setQueryData<UserInfo>(ACCOUNT_QUERY_KEY, { rootDirUuid: testUuid("root") } as UserInfo)
	useDriveClipboardStore.getState().clear()
})

describe("a cut follows its items", () => {
	it("moves the saved version after a content save, whichever of its two events lands first", async () => {
		for (const order of ["archivedFirst", "newFirst"] as const) {
			cutToClipboard([U1])

			const archived = () => {
				drive({ type: "fileArchived", uuid: testUuid("u1"), stableUUID: STABLE, newUUID: testUuid("u2") })
			}
			const successor = () => {
				drive({ type: "fileNew", file: rawFile("u2", { meta: fileMeta("a.txt") }) })
			}

			if (order === "archivedFirst") {
				archived()
				expect(uuids()).toEqual([testUuid("u1")])
				successor()
			} else {
				successor()
				archived()
			}

			expect(uuids()).toEqual([testUuid("u2")])
			expect([...useDriveClipboardStore.getState().cutUuids]).toEqual([testUuid("u2")])
		}

		performMove.mockResolvedValue({ succeeded: [], failed: [] })
		await pasteClipboard(DESTINATION)

		expect(performMove.mock.calls[0]?.[0]).toMatchObject([{ data: { uuid: testUuid("u2") } }])
	})

	it("waits for the successor when a save on an account without versioning trashes the old version", () => {
		cutToClipboard([U1])

		drive({ type: "fileTrash", uuid: testUuid("u1"), stableUUID: testUuid("retired"), newUUID: testUuid("u2") })
		expect(uuids()).toEqual([testUuid("u1")])

		drive({ type: "fileNew", file: rawFile("u2") })
		expect(uuids()).toEqual([testUuid("u2")])
	})

	// A move re-encrypts the passed item's name for the destination's shares and links.
	it("passes the renamed item to the move", async () => {
		cutToClipboard([U1])
		drive({ type: "fileMetadataChanged", uuid: testUuid("u1"), metadata: fileMeta("b.txt") })

		performMove.mockResolvedValue({ succeeded: [], failed: [] })
		await pasteClipboard(DESTINATION)

		expect(performMove.mock.calls[0]?.[0]).toMatchObject([{ data: { uuid: testUuid("u1"), decryptedMeta: { name: "b.txt" } } }])
	})

	it("follows a directory's rename, color and move, and a file's move and restored version", () => {
		cutToClipboard([DOCS, U1])

		drive({ type: "folderMetadataChanged", uuid: testUuid("docs"), meta: { type: "decoded", data: { name: "papers" } } })
		drive({ type: "folderColorChanged", uuid: testUuid("docs"), color: "red" })
		// Like the SDK's, with the default colour: the red must survive it.
		drive({ type: "folderMove", dir: rawDir("docs", { parent: ELSEWHERE, meta: { type: "decoded", data: { name: "papers" } } }) })
		drive({ type: "fileMove", file: rawFile("u1", { parent: ELSEWHERE }) })
		drive({ type: "fileArchiveRestored", currentUuid: testUuid("u1"), file: rawFile("u0", { parent: ELSEWHERE }) })

		expect(entry()?.items).toMatchObject([
			{ data: { uuid: testUuid("docs"), parent: ELSEWHERE, color: "red", decryptedMeta: { name: "papers" } } },
			{ data: { uuid: testUuid("u0"), parent: ELSEWHERE } }
		])
		expect([...useDriveClipboardStore.getState().cutUuids]).toEqual([testUuid("docs"), testUuid("u0")])
	})

	it("follows this tab's own renames, moves, color changes, version restores and saves", async () => {
		cutToClipboard([U1, DOCS])

		renameFile.mockResolvedValue(rawFile("u1", { meta: fileMeta("b.txt") }))
		await renameItem(U1, "b.txt")
		expect(names()).toEqual(["b.txt", "docs"])

		moveFile.mockResolvedValue(rawFile("u1", { parent: ELSEWHERE, meta: fileMeta("b.txt") }))
		await moveItems([U1], ELSEWHERE)
		expect(entry()?.items[0]?.data.parent).toBe(ELSEWHERE)

		setDirectoryColor.mockResolvedValue(rawDir("docs", { color: "blue" }))
		await setColor(DOCS as Extract<DriveItem, { type: "directory" }>, "blue")
		expect(entry()?.items[1]).toMatchObject({ data: { color: "blue" } })

		restoreFileVersionOp.mockResolvedValue(rawFile("u9", { parent: ELSEWHERE }))
		await restoreVersion(U1 as Extract<DriveItem, { type: "file" }>, { uuid: testUuid("u9") } as FileVersion)
		expect(uuids()).toEqual([testUuid("u9"), testUuid("docs")])

		// The preview's save hands its result over the same way.
		followClipboardItem(narrowItem(rawFile("u10")), testUuid("u9"))
		expect(uuids()).toEqual([testUuid("u10"), testUuid("docs")])
	})
})

describe("a copy follows its items", () => {
	it("pastes the current name and newest version after renames, content saves and moves", async () => {
		copyToClipboard([U1, DOCS])

		drive({ type: "fileMetadataChanged", uuid: testUuid("u1"), metadata: fileMeta("b.txt") })
		drive({ type: "fileArchived", uuid: testUuid("u1"), stableUUID: STABLE, newUUID: testUuid("u2") })
		drive({ type: "fileNew", file: rawFile("u2", { meta: fileMeta("b.txt") }) })
		drive({ type: "folderColorChanged", uuid: testUuid("docs"), color: "red" })
		drive({ type: "folderMove", dir: rawDir("docs", { parent: ELSEWHERE, meta: { type: "decoded", data: { name: "papers" } } }) })

		expect(entry()?.mode).toBe("copy")
		expect(useDriveClipboardStore.getState().cutUuids.size).toBe(0)

		await pasteClipboard(DESTINATION)

		expect(startCopyWithCard.mock.calls[0]?.[0]).toMatchObject([
			{ data: { uuid: testUuid("u2"), decryptedMeta: { name: "b.txt" } } },
			{ data: { uuid: testUuid("docs"), parent: ELSEWHERE, color: "red", decryptedMeta: { name: "papers" } } }
		])
		// A copy stays for further pastes.
		expect(uuids()).toEqual([testUuid("u2"), testUuid("docs")])
	})

	it("follows this tab's own renames and saves", async () => {
		copyToClipboard([U1])

		renameFile.mockResolvedValue(rawFile("u1", { meta: fileMeta("b.txt") }))
		await renameItem(U1, "b.txt")
		expect(names()).toEqual(["b.txt"])

		followClipboardItem(narrowItem(rawFile("u2", { meta: fileMeta("b.txt") })), testUuid("u1"))
		expect(uuids()).toEqual([testUuid("u2")])
	})
})

describe("trashed and deleted items leave the clipboard", () => {
	it("drops a trashed file from a copy and a directory from a cut, emptying what empties", () => {
		copyToClipboard([U1, DOCS])
		drive({ type: "fileTrash", uuid: testUuid("u1"), stableUUID: STABLE, newUUID: undefined })

		expect(uuids()).toEqual([testUuid("docs")])

		cutToClipboard([DOCS])
		drive({ type: "folderTrash", parent: HOME, uuid: testUuid("docs") })

		expect(entry()).toBeNull()
		expect(useDriveClipboardStore.getState().cutUuids.size).toBe(0)
	})

	it("drops a file whose whole lineage is deleted, but not one whose old version is", () => {
		const older = narrowItem(rawFile("u0"))

		copyToClipboard([older, DOCS])
		drive({ type: "fileDeletedPermanent", uuid: testUuid("u0-version"), stableUUID: undefined })
		expect(uuids()).toEqual([testUuid("u0"), testUuid("docs")])

		// The live head is deleted for good: the version a copy holds goes with its lineage.
		drive({ type: "fileDeletedPermanent", uuid: testUuid("u1"), stableUUID: STABLE })
		expect(uuids()).toEqual([testUuid("docs")])

		drive({ type: "folderDeletedPermanent", uuid: testUuid("docs") })
		expect(entry()).toBeNull()
	})

	it("drops a file another one was moved over", () => {
		copyToClipboard([U1])
		drive({ type: "fileArchived", uuid: testUuid("u1"), stableUUID: STABLE, newUUID: undefined })

		expect(entry()).toBeNull()
	})

	it("drops what this tab trashes or deletes", async () => {
		copyToClipboard([U1, DOCS])

		trashFile.mockResolvedValue(rawFile("u1"))
		await trashItems([U1])
		expect(uuids()).toEqual([testUuid("docs")])

		cutToClipboard([U1])
		deleteFilePermanently.mockResolvedValue(undefined)
		await deleteItemsPermanently([U1])
		expect(entry()).toBeNull()
	})

	it("empties on an account-wide delete", () => {
		cutToClipboard([U1, DOCS])
		drive({ type: "deleteAll" })

		expect(entry()).toBeNull()
	})

	it("keeps the state untouched by a change to anything else, so nothing re-renders", () => {
		cutToClipboard([U1])

		const before = useDriveClipboardStore.getState()

		drive({ type: "fileMetadataChanged", uuid: testUuid("other"), metadata: fileMeta("x.txt") })
		drive({ type: "fileTrash", uuid: testUuid("other"), stableUUID: testUuid("other-stable"), newUUID: undefined })
		drive({ type: "fileNew", file: rawFile("other", { stableUUID: testUuid("other-stable") }) })

		expect(useDriveClipboardStore.getState()).toBe(before)
	})

	it("looks at no held item for a change about none of them", () => {
		copyToClipboard([U1, DOCS])

		const update = vi.fn((item: DriveItem) => item)

		useDriveClipboardStore.getState().follow({ keys: [testUuid("other"), testUuid("other-stable")], update })
		expect(update).not.toHaveBeenCalled()

		useDriveClipboardStore.getState().follow({ keys: [STABLE], update })
		expect(update).toHaveBeenCalledTimes(2)
	})
})

describe("a cut being pasted", () => {
	function holdMove(): (outcome: unknown) => void {
		let settle: (outcome: unknown) => void = () => undefined

		performMove.mockReturnValue(
			new Promise(resolve => {
				settle = resolve
			})
		)

		return outcome => {
			settle(outcome)
		}
	}

	it("brings back what failed to move as it now is", async () => {
		const settle = holdMove()

		cutToClipboard([U1, DOCS])

		const pasted = pasteClipboard(DESTINATION)

		drive({ type: "fileNew", file: rawFile("u2") })
		settle({ succeeded: [DOCS], failed: [{ item: U1, error: new Error("no") }] })
		await pasted

		expect(entry()?.mode).toBe("cut")
		expect(uuids()).toEqual([testUuid("u2")])
	})

	it("doesn't bring back what was trashed meanwhile, or anything once the clipboard was cleared", async () => {
		const settleTrashed = holdMove()

		cutToClipboard([U1])

		const trashed = pasteClipboard(DESTINATION)

		drive({ type: "fileTrash", uuid: testUuid("u1"), stableUUID: STABLE, newUUID: undefined })
		settleTrashed({ succeeded: [], failed: [{ item: U1, error: new Error("no") }] })
		await trashed

		expect(entry()).toBeNull()

		const settleCleared = holdMove()

		cutToClipboard([DOCS])

		const cleared = pasteClipboard(DESTINATION)

		useDriveClipboardStore.getState().clear()
		settleCleared({ succeeded: [], failed: [{ item: DOCS, error: new Error("no") }] })
		await cleared

		expect(entry()).toBeNull()
	})
})
