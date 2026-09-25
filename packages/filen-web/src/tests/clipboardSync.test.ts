import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import type {
	Dir,
	File,
	FileMeta,
	FileVersion,
	NormalDirsAndFiles,
	SharedFile,
	SharedRootDirsAndFiles,
	SharingRole,
	SocketEvent,
	UserInfo,
	UuidStr
} from "@filen/sdk-rs"
import type { ListDirectoryTarget } from "@/workers/sdk.worker"

// A clipboard entry is a snapshot of the items at Copy/Cut time; this pins what keeps it current. Events
// go in through the real drive socket handler and writes through the real drive actions, so the wiring is
// covered along with the mapping.

const {
	performMove,
	startCopyWithCard,
	renameFile,
	moveFile,
	trashFile,
	deleteFilePermanently,
	setDirectoryColor,
	restoreFileVersionOp,
	listDirectory,
	listSharedOutRoot,
	toastWarning,
	toastError
} = vi.hoisted(() => ({
	performMove: vi.fn(),
	startCopyWithCard: vi.fn(),
	renameFile: vi.fn(),
	moveFile: vi.fn(),
	trashFile: vi.fn(),
	deleteFilePermanently: vi.fn(),
	setDirectoryColor: vi.fn(),
	restoreFileVersionOp: vi.fn(),
	listDirectory: vi.fn<(target: ListDirectoryTarget) => Promise<NormalDirsAndFiles>>(),
	listSharedOutRoot: vi.fn<() => Promise<SharedRootDirsAndFiles>>(),
	toastWarning: vi.fn(),
	toastError: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: {
		renameFile,
		moveFile,
		trashFile,
		deleteFilePermanently,
		setDirectoryColor,
		restoreFileVersionOp,
		listDirectory,
		listSharedOutRoot
	}
}))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock("@/features/drive/lib/dnd", () => ({ performMove }))
vi.mock("@/features/transfers/lib/copyToast", () => ({ startCopyWithCard }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: toastError, warning: toastWarning } }))

import "@/lib/i18n"
import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { socketAuthenticated, socketDropped } from "@/lib/sdk/socketSession"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { discardListingPatches, driveListingQueryKey, driveListingQueryOptions } from "@/features/drive/queries/drive"
import {
	handleDriveAuthSuccess,
	handleDriveEvent,
	handleDriveReconnecting,
	markDriveEventsMissed
} from "@/features/drive/lib/socketHandlers"
import { deleteItemsPermanently, moveItems, renameItem, restoreVersion, setColor, trashItems } from "@/features/drive/lib/actions"
import { followClipboardItem } from "@/features/drive/lib/clipboardSync"
import { recheckClipboard } from "@/features/drive/lib/clipboardRecheck"
import { copyToClipboard, cutToClipboard, pasteClipboard } from "@/features/drive/lib/clipboard"
import { isClipboardCurrent, useDriveClipboardStore } from "@/features/drive/store/useDriveClipboardStore"

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
	// Creates an earlier test's events queued would land in this one's listings.
	discardListingPatches()
	queryClient.clear()
	queryClient.setQueryData<UserInfo>(ACCOUNT_QUERY_KEY, { rootDirUuid: testUuid("root") } as UserInfo)
	useDriveClipboardStore.getState().clear()
	socketAuthenticated()
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

const RECEIVER: SharingRole = { Receiver: { email: "friend@filen.io", id: 7 } }
const SHARER: SharingRole = { Sharer: { email: "owner@filen.io", id: 8 } }
const LINEAGE = testUuid("lineage")

function rawSharedFile(uuid: string, role: SharingRole, meta: FileMeta = fileMeta("report.pdf")): SharedFile {
	return {
		uuid: testUuid(uuid),
		size: 1n,
		region: "de-1",
		bucket: "filen-1",
		chunks: 1n,
		timestamp: 0n,
		meta,
		sharingRole: role,
		sharedTag: true,
		canMakeThumbnail: false
	}
}

// Shared by me rows carry no stable id, at the root and nested alike, but their owner's events arrive.
describe("a Shared by me file follows its content saves", () => {
	const retire = (type: "fileArchived" | "fileTrash") => {
		drive({ type, uuid: testUuid("s1"), stableUUID: type === "fileArchived" ? LINEAGE : testUuid("fresh"), newUUID: testUuid("s2") })
	}
	const successor = () => {
		drive({ type: "fileNew", file: rawFile("s2", { stableUUID: LINEAGE }) })
	}

	it("copies the saved version, root or nested, whichever of its two events lands first", async () => {
		const root = narrowItem(rawSharedFile("s1", RECEIVER))
		const nested = narrowItem({ ...rawFile("s1"), stableUUID: undefined, sharingRole: RECEIVER })

		expect([root.type, nested.type]).toEqual(["sharedRootFile", "sharedFile"])

		for (const held of [root, nested]) {
			for (const successorFirst of [false, true]) {
				copyToClipboard([held])

				if (successorFirst) {
					successor()
					expect(uuids()).toEqual([testUuid("s1")])
					retire("fileArchived")
				} else {
					retire("fileArchived")
					expect(uuids()).toEqual([testUuid("s1")])
					successor()
				}

				expect(entry()?.items).toMatchObject([{ type: "file", data: { uuid: testUuid("s2"), stableUUID: LINEAGE } }])
			}
		}

		await pasteClipboard(DESTINATION)

		expect(startCopyWithCard.mock.calls[0]?.[0]).toMatchObject([{ data: { uuid: testUuid("s2") } }])
	})

	// Without versioning the retired row is trashed under a freshly minted stable id: only the uuid pairs it.
	it("follows a save on an account without versioning, in either order", () => {
		for (const successorFirst of [false, true]) {
			cutToClipboard([narrowItem(rawSharedFile("s1", RECEIVER))])

			if (successorFirst) {
				successor()
				retire("fileTrash")
			} else {
				retire("fileTrash")
				successor()
			}

			expect(uuids()).toEqual([testUuid("s2")])
			expect([...useDriveClipboardStore.getState().cutUuids]).toEqual([testUuid("s2")])
		}
	})

	it("keeps the state untouched by another file's save", () => {
		copyToClipboard([narrowItem(rawSharedFile("s1", RECEIVER))])

		const before = useDriveClipboardStore.getState()

		drive({ type: "fileNew", file: rawFile("o2", { stableUUID: testUuid("other-lineage") }) })
		drive({ type: "fileArchived", uuid: testUuid("o1"), stableUUID: testUuid("other-lineage"), newUUID: testUuid("o2") })
		drive({ type: "fileArchived", uuid: testUuid("o3"), stableUUID: testUuid("third-lineage"), newUUID: testUuid("o4") })
		drive({ type: "fileNew", file: rawFile("o4", { stableUUID: testUuid("third-lineage") }) })

		expect(useDriveClipboardStore.getState()).toBe(before)
	})
})

describe("a paste after the socket missed events", () => {
	// A drop and the reconnect that ends it, in the order the socket bridge delivers them.
	function socketGap(): void {
		socketDropped()
		handleDriveReconnecting()
		socketAuthenticated()
		handleDriveAuthSuccess()
	}

	function listHome(listing: Partial<NormalDirsAndFiles>): void {
		listDirectory.mockImplementation(target =>
			Promise.resolve(target.kind === "uuid" && target.uuid === HOME ? { dirs: [], files: [], ...listing } : { dirs: [], files: [] })
		)
	}

	// The listing the items are copied from, read while the socket is up.
	async function browseHome(listing: Partial<NormalDirsAndFiles>): Promise<void> {
		listHome(listing)
		await queryClient.query(driveListingQueryOptions("drive", HOME))
		listDirectory.mockClear()
	}

	function homeRows(): DriveItem[] {
		return queryClient.getQueryData<DriveItem[]>(driveListingQueryKey({ variant: "drive", uuid: HOME })) ?? []
	}

	it("looks nothing up while the socket stayed up", async () => {
		copyToClipboard([U1, DOCS])

		const before = entry()

		await expect(recheckClipboard()).resolves.toBe(true)
		expect(listDirectory).not.toHaveBeenCalled()
		expect(entry()).toBe(before)
	})

	it("moves a cut item as the listing read since the gap shows it, reading nothing more", async () => {
		await browseHome({ files: [rawFile("u1")] })
		cutToClipboard([U1])
		socketGap()
		listHome({ files: [rawFile("u1", { meta: fileMeta("b.txt") })] })

		// The listing on screen re-reads after the reconnect.
		await queryClient.query(driveListingQueryOptions("drive", HOME))
		await expect(recheckClipboard()).resolves.toBe(true)
		expect(listDirectory).toHaveBeenCalledOnce()

		performMove.mockResolvedValue({ succeeded: [], failed: [] })
		await pasteClipboard(DESTINATION)

		expect(performMove.mock.calls[0]?.[0]).toMatchObject([{ data: { uuid: testUuid("u1"), decryptedMeta: { name: "b.txt" } } }])
	})

	it("reads a listing the cache holds once for all its items, and leaves out what it no longer holds", async () => {
		await browseHome({ files: [rawFile("u1")], dirs: [rawDir("docs")] })
		copyToClipboard([U1, DOCS])
		socketGap()
		listHome({ dirs: [rawDir("docs", { color: "red", meta: { type: "decoded", data: { name: "papers" } } })] })

		await expect(recheckClipboard()).resolves.toBe(true)
		expect(listDirectory).toHaveBeenCalledOnce()
		expect(entry()?.items).toMatchObject([{ data: { uuid: testUuid("docs"), color: "red", decryptedMeta: { name: "papers" } } }])
		expect(toastWarning).toHaveBeenCalledExactlyOnceWith("1 item was moved or deleted and won't be pasted")

		await pasteClipboard(DESTINATION)

		expect(startCopyWithCard.mock.calls[0]?.[0]).toMatchObject([{ data: { uuid: testUuid("docs") } }])

		// Current again: the next paste reads nothing.
		await expect(recheckClipboard()).resolves.toBe(true)
		expect(listDirectory).toHaveBeenCalledOnce()
	})

	it("follows a content save made during the gap by the file's stable id", async () => {
		await browseHome({ files: [rawFile("u1")] })
		cutToClipboard([U1])
		socketGap()
		listHome({ files: [rawFile("u2")] })

		await expect(recheckClipboard()).resolves.toBe(true)

		expect(uuids()).toEqual([testUuid("u2")])
		expect([...useDriveClipboardStore.getState().cutUuids]).toEqual([testUuid("u2")])
		expect(toastWarning).not.toHaveBeenCalled()
	})

	// Its fileNew queues the successor for the listing's next batch of creates.
	it("finds a successor saved just before the paste in its listing", async () => {
		await browseHome({ files: [rawFile("u1")] })
		copyToClipboard([U1])
		socketGap()
		await queryClient.query(driveListingQueryOptions("drive", HOME))
		drive({ type: "fileArchived", uuid: testUuid("u1"), stableUUID: STABLE, newUUID: testUuid("u2") })
		drive({ type: "fileNew", file: rawFile("u2") })

		await expect(recheckClipboard()).resolves.toBe(true)
		expect(uuids()).toEqual([testUuid("u2")])
		expect(toastWarning).not.toHaveBeenCalled()
	})

	// An undecodable event loses a change without the socket dropping.
	it("looks again after an event that couldn't be decoded", async () => {
		await browseHome({ files: [rawFile("u1")] })
		copyToClipboard([U1])
		markDriveEventsMissed()
		listHome({ files: [rawFile("u1", { meta: fileMeta("b.txt") })] })

		expect(isClipboardCurrent()).toBe(false)
		await expect(recheckClipboard()).resolves.toBe(true)
		expect(names()).toEqual(["b.txt"])
		expect(isClipboardCurrent()).toBe(true)
	})

	it("refuses the paste and keeps the items when their listing can't be read", async () => {
		await browseHome({ files: [rawFile("u1")] })
		copyToClipboard([U1])
		socketGap()
		listDirectory.mockRejectedValue(new Error("network down"))

		await expect(recheckClipboard()).resolves.toBe(false)
		expect(toastError).toHaveBeenCalledOnce()
		expect(uuids()).toEqual([testUuid("u1")])
		expect(isClipboardCurrent()).toBe(false)
	})

	it("looks a Shared by me root row up among the Shared by me root's rows", async () => {
		listSharedOutRoot.mockResolvedValue({ dirs: [], files: [rawSharedFile("s1", RECEIVER)] })
		await queryClient.query(driveListingQueryOptions("sharedOut", null))
		copyToClipboard([narrowItem(rawSharedFile("s1", RECEIVER))])
		socketGap()
		listSharedOutRoot.mockResolvedValue({ dirs: [], files: [rawSharedFile("s1", RECEIVER, fileMeta("renamed.pdf"))] })

		await expect(recheckClipboard()).resolves.toBe(true)

		expect(names()).toEqual(["renamed.pdf"])
		expect(listDirectory).not.toHaveBeenCalled()
	})

	it("leaves an item shared with the user as it is, reading nothing", async () => {
		const sharedIn = narrowItem(rawSharedFile("in1", SHARER))

		copyToClipboard([sharedIn])
		socketGap()

		await expect(recheckClipboard()).resolves.toBe(true)
		expect(entry()?.items).toEqual([sharedIn])
		expect(listDirectory).not.toHaveBeenCalled()
		expect(listSharedOutRoot).not.toHaveBeenCalled()
	})

	it("looks again at what a cut failed to move when the socket dropped while it moved", async () => {
		let settle: (outcome: unknown) => void = () => undefined

		performMove.mockReturnValue(
			new Promise(resolve => {
				settle = resolve
			})
		)
		cutToClipboard([U1])

		const pasted = pasteClipboard(DESTINATION)

		socketGap()
		settle({ succeeded: [], failed: [{ item: U1, error: new Error("no") }] })
		await pasted

		expect(uuids()).toEqual([testUuid("u1")])
		expect(isClipboardCurrent()).toBe(false)
	})

	// A trashed directory can't be listed, and a deleted one no longer resolves.
	it.each([
		{ gone: "trashed", error: { species: "sdk", kind: "FolderNotFound", label: "Folder not found", message: "Folder not found" } },
		{ gone: "deleted", error: { species: "plain", label: `directory not found: ${HOME}`, message: `directory not found: ${HOME}` } }
	])("leaves out what a $gone directory held and pastes the rest", async ({ error }) => {
		const elsewhere = (name: string) => rawFile("e1", { parent: ELSEWHERE, stableUUID: testUuid("e-lineage"), meta: fileMeta(name) })
		const listHomeDirectory = vi.fn(() => Promise.resolve<NormalDirsAndFiles>({ dirs: [], files: [rawFile("u1")] }))
		let elsewhereName = "e.txt"

		listDirectory.mockImplementation(target =>
			target.kind === "uuid" && target.uuid === HOME
				? listHomeDirectory()
				: Promise.resolve({ dirs: [], files: [elsewhere(elsewhereName)] })
		)
		await queryClient.query(driveListingQueryOptions("drive", HOME))
		await queryClient.query(driveListingQueryOptions("drive", ELSEWHERE))
		copyToClipboard([U1, narrowItem(elsewhere("e.txt"))])
		socketGap()
		listDirectory.mockClear()
		listHomeDirectory.mockRejectedValue(error)
		elsewhereName = "f.txt"

		await expect(recheckClipboard()).resolves.toBe(true)
		expect(names()).toEqual(["f.txt"])
		expect(toastWarning).toHaveBeenCalledExactlyOnceWith("1 item was moved or deleted and won't be pasted")
		expect(toastError).not.toHaveBeenCalled()

		await pasteClipboard(DESTINATION)

		expect(startCopyWithCard.mock.calls[0]?.[0]).toMatchObject([{ data: { uuid: testUuid("e1") } }])

		await expect(recheckClipboard()).resolves.toBe(true)
		expect(listDirectory).toHaveBeenCalledTimes(2)
	})

	// Only the reconnect's own refetch goes on to the read that replaces the one it cancels.
	it("moves on to the read that replaced one the reconnect cancelled", async () => {
		await browseHome({ files: [rawFile("u1")] })
		copyToClipboard([U1])
		socketDropped()
		handleDriveReconnecting()
		socketAuthenticated()

		const reads: ((listing: NormalDirsAndFiles) => void)[] = []

		listDirectory.mockImplementation(
			() =>
				new Promise(resolve => {
					reads.push(resolve)
				})
		)

		// The listing on screen starts re-reading, the lookup joins that read, and the authSuccess ending the
		// drop cancels it for a read of its own.
		const unsubscribe = new QueryObserver(queryClient, driveListingQueryOptions("drive", HOME)).subscribe(() => undefined)
		const rechecked = recheckClipboard()

		handleDriveAuthSuccess()

		for (const land of reads) {
			land({ dirs: [], files: [rawFile("u1", { meta: fileMeta("b.txt") })] })
		}

		await expect(rechecked).resolves.toBe(true)
		expect(names()).toEqual(["b.txt"])
		expect(toastError).not.toHaveBeenCalled()
		expect(listDirectory).toHaveBeenCalledTimes(2)

		unsubscribe()
	})

	// As logout cancels every read.
	it("gives up quietly on a read cancelled for good", async () => {
		await browseHome({ files: [rawFile("u1")] })
		copyToClipboard([U1])
		socketGap()
		listDirectory.mockImplementation(() => new Promise(() => undefined))

		const unsubscribe = new QueryObserver(queryClient, driveListingQueryOptions("drive", HOME)).subscribe(() => undefined)
		const rechecked = recheckClipboard()

		await queryClient.cancelQueries()

		await expect(rechecked).resolves.toBe(false)
		expect(toastError).not.toHaveBeenCalled()

		unsubscribe()
	})

	it("reads no listing the cache doesn't hold, however many directories the items come from", async () => {
		await browseHome({ files: [rawFile("u1")] })

		// Search hits from directories never opened here.
		const hits = ["p1", "p2", "p3"].map(label =>
			narrowItem(rawFile(`${label}-hit`, { parent: testUuid(label), stableUUID: testUuid(`${label}-lineage`) }))
		)

		copyToClipboard([U1, ...hits])
		socketGap()
		listHome({ files: [rawFile("u1", { meta: fileMeta("b.txt") })] })

		await expect(recheckClipboard()).resolves.toBe(true)
		expect(listDirectory).toHaveBeenCalledExactlyOnceWith({ kind: "uuid", uuid: HOME })

		for (const label of ["p1", "p2", "p3"]) {
			expect(queryClient.getQueryData(driveListingQueryKey({ variant: "drive", uuid: testUuid(label) }))).toBeUndefined()
		}

		await pasteClipboard(DESTINATION)

		expect(startCopyWithCard.mock.calls[0]?.[0]).toMatchObject([{ data: { decryptedMeta: { name: "b.txt" } } }, ...hits])
	})

	it("looks up rows copied from a listing whose read after the gap hasn't landed", async () => {
		await browseHome({ files: [rawFile("u1")] })
		socketGap()

		let land: (listing: NormalDirsAndFiles) => void = () => undefined

		listDirectory.mockImplementation(
			() =>
				new Promise(resolve => {
					land = resolve
				})
		)

		const reread = queryClient.query(driveListingQueryOptions("drive", HOME))

		// The rows on screen until the read lands.
		cutToClipboard(homeRows())
		land({ dirs: [], files: [rawFile("u1", { meta: fileMeta("b.txt") })] })
		await reread

		await expect(recheckClipboard()).resolves.toBe(true)
		expect(listDirectory).toHaveBeenCalledOnce()

		performMove.mockResolvedValue({ succeeded: [], failed: [] })
		await pasteClipboard(DESTINATION)

		expect(performMove.mock.calls[0]?.[0]).toMatchObject([{ data: { uuid: testUuid("u1"), decryptedMeta: { name: "b.txt" } } }])
	})

	it("looks up rows restored from disk until their listing's first read", async () => {
		// As the boot restore seeds it.
		queryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid: HOME }), [U1])
		copyToClipboard(homeRows())

		expect(isClipboardCurrent()).toBe(false)

		listHome({ files: [rawFile("u1", { meta: fileMeta("b.txt") })] })

		await expect(recheckClipboard()).resolves.toBe(true)
		expect(names()).toEqual(["b.txt"])
		expect(listDirectory).toHaveBeenCalledOnce()
	})

	it("holds what's copied as its current listing now has it, looking nothing up", async () => {
		await browseHome({ files: [rawFile("u1")] })

		// Selected before the rename reached the listing.
		const selected = homeRows()

		drive({ type: "fileMetadataChanged", uuid: testUuid("u1"), metadata: fileMeta("b.txt") })
		copyToClipboard(selected)

		expect(names()).toEqual(["b.txt"])
		expect(isClipboardCurrent()).toBe(true)
	})
})
