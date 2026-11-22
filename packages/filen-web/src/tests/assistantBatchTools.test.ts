// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Dir, File, UserInfo } from "@filen/sdk-rs"
import { assistantToolByName, parseToolInput, type AssistantToolFailure } from "@filen/shared/assistant"
import { testUuid } from "@/tests/support/uuid"

// The SDK below the user's own action modules: the batch tools must reach it only through them.
const sdk = vi.hoisted(() => ({
	listDirectory: vi.fn(),
	getItemInfo: vi.fn(),
	getItemPath: vi.fn(),
	renameFile: vi.fn(),
	renameDirectory: vi.fn(),
	moveFile: vi.fn(),
	moveDirectory: vi.fn(),
	createDirectory: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: sdk }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }))
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() }) }))

import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { CONTACTS_QUERY_KEY } from "@/features/contacts/queries/contacts"
import { driveListingQueryKey, driveListingQueryOptions } from "@/features/drive/queries/drive"
import { socketAuthenticated, socketDropped } from "@/lib/sdk/socketSession"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { createAssistantToolExecutor } from "@/features/assistant/tools/executor"
import { buildProposal } from "@/features/assistant/loop/executorAdapter"
import type { AssistantToolExecution, ToolExecutor } from "@/features/assistant/runtime/executor"

const ROOT = testUuid("root")
// Uploaded after every date the files carry, so a capture date counts.
const TIMESTAMP = BigInt(Date.UTC(2025, 0, 1))
// 2023-03-04 and 2024-07-08, midday UTC: the same day in any zone the tests run in.
const MARCH_2023 = BigInt(Date.UTC(2023, 2, 4, 12))
const JULY_2024 = BigInt(Date.UTC(2024, 6, 8, 12))

function rawDir(uuid: string, name: string, parent: string): Dir {
	return { uuid, parent, color: "default", timestamp: TIMESTAMP, favorited: false, meta: { type: "decoded", data: { name } } } as Dir
}

function rawFile(uuid: string, name: string, parent: string, created: bigint, mime = "image/jpeg"): File {
	return {
		uuid,
		stableUUID: undefined,
		parent,
		size: 64n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: TIMESTAMP,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime, created, modified: created, size: 64n, key: "key", version: 2 } }
	} as File
}

const PHOTOS = testUuid("photos")
const OLD = testUuid("2023")
const photosRaw = rawDir(PHOTOS, "Photos", ROOT)
const oldRaw = rawDir(OLD, "2023", PHOTOS)
const beachRaw = rawFile(testUuid("beach"), "beach.jpg", PHOTOS, MARCH_2023)
const hikeRaw = rawFile(testUuid("hike"), "hike.jpg", PHOTOS, JULY_2024)
const notesRaw = rawFile(testUuid("notes"), "notes.txt", PHOTOS, JULY_2024, "text/plain")
// Already in the 2023 subdirectory, under the name beach.jpg would take there.
const takenRaw = rawFile(testUuid("taken"), "Beach.jpg", OLD, MARCH_2023)

const LISTINGS = new Map<string | null, { dirs: Dir[]; files: File[] }>([
	[null, { dirs: [photosRaw], files: [] }],
	[PHOTOS, { dirs: [oldRaw], files: [beachRaw, hikeRaw, notesRaw] }],
	[OLD, { dirs: [], files: [takenRaw] }]
])

let executor: ToolExecutor

type CallOutcome = AssistantToolExecution | AssistantToolFailure

function tool(name: string) {
	const found = assistantToolByName(name)

	if (found === undefined) {
		throw new Error(`no tool ${name}`)
	}

	return found
}

// One call the way the loop makes it: schema, check, preview for the card, then execute with the checked arguments.
async function run(name: string, args: Record<string, unknown>) {
	const definition = tool(name)

	if (!parseToolInput(definition, args).ok) {
		throw new Error(`bad test call ${name}`)
	}

	const checked = await executor.check({ callId: "call", tool: definition, args })

	if (!checked.ok) {
		return { checked, preview: null, execute: () => Promise.resolve<CallOutcome>(checked) }
	}

	const preview = await executor.preview({ tool: definition, args: checked.args })

	return {
		checked,
		preview: preview.ok ? buildProposal({ id: "p", tool: definition, args: checked.args, preview }) : null,
		execute: () =>
			executor.execute({
				callId: "call",
				tool: definition,
				args: checked.args,
				confirmed: true,
				signal: new AbortController().signal
			})
	}
}

function listing(uuid: string | null): DriveItem[] {
	const raw = LISTINGS.get(uuid)

	return [...(raw?.dirs ?? []).map(narrowItem), ...(raw?.files ?? []).map(narrowItem)]
}

beforeEach(async () => {
	vi.clearAllMocks()
	queryClient.clear()
	queryClient.setQueryData<Partial<UserInfo>>(ACCOUNT_QUERY_KEY, { id: 1n, rootDirUuid: ROOT })
	queryClient.setQueryData(CONTACTS_QUERY_KEY, { contacts: [], blocked: [] })

	for (const uuid of LISTINGS.keys()) {
		queryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid }), listing(uuid))
	}

	sdk.listDirectory.mockImplementation((target: { kind: string; uuid?: string }) =>
		Promise.resolve(LISTINGS.get(target.kind === "root" ? null : (target.uuid ?? null)) ?? { dirs: [], files: [] })
	)
	sdk.getItemInfo.mockResolvedValue({ path: "/Photos", ancestors: [] })
	sdk.renameFile.mockImplementation((item: File, name: string) =>
		Promise.resolve({ ...item, meta: { type: "decoded", data: { ...(item.meta as { data: object }).data, name } } })
	)
	sdk.moveFile.mockImplementation((item: File, parent: string) => Promise.resolve({ ...item, parent }))
	sdk.createDirectory.mockImplementation((parent: string, name: string) => Promise.resolve(rawDir(testUuid(`new-${name}`), name, parent)))
	useDriveStore.setState({ selectedItems: [], pendingReveal: null })
	executor = createAssistantToolExecutor()
	// The model learned d1 Photos from the root's listing.
	await executor.execute({
		callId: "look",
		tool: tool("list_directory"),
		args: { handle: "d0" },
		confirmed: false,
		signal: new AbortController().signal
	})
})

describe("rename_by_pattern", () => {
	it("shows the plan code worked out, and runs exactly that once confirmed", async () => {
		const call = await run("rename_by_pattern", { scope: "d1", kind: "image", scheme: "date_prefix", text: "ignored" })

		// A text the scheme does not use never reaches the guard or the card.
		expect(call.checked).toMatchObject({ ok: true, args: { scope: "d1", kind: "image", scheme: "date_prefix" } })
		expect(call.checked.ok && "text" in call.checked.args).toBe(false)
		expect(call.preview).toMatchObject({
			action: "batch-rename",
			targets: [],
			destination: "/Photos",
			text: {},
			batch: {
				rule: { scheme: "date_prefix" },
				changes: [
					{ from: "beach.jpg", to: "2023-03-04 beach.jpg", suffixed: false },
					{ from: "hike.jpg", to: "2024-07-08 hike.jpg", suffixed: false }
				],
				skipped: []
			}
		})
		expect(sdk.renameFile).not.toHaveBeenCalled()

		expect(await call.execute()).toMatchObject({ ok: true, result: { renamed: 2 } })
		expect(sdk.renameFile.mock.calls.map(([, name]) => name as string).sort()).toEqual(["2023-03-04 beach.jpg", "2024-07-08 hike.jpg"])
		// The check's plan is the card's and the run's: the directory is read once.
		expect(sdk.listDirectory.mock.calls.filter(([target]) => (target as { uuid?: string }).uuid === PHOTOS)).toHaveLength(1)
	})

	it("refuses before a card when no name would change", async () => {
		const call = await run("rename_by_pattern", { scope: "d1", kind: "image", scheme: "lowercase" })

		expect(call.checked).toMatchObject({ ok: false, error: "No file would get a new name; nothing to rename" })
	})

	it("skips a file renamed since the card showed it", async () => {
		const call = await run("rename_by_pattern", { scope: "d1", kind: "image", scheme: "add_prefix", text: "trip " })
		const renamed = narrowItem({
			...beachRaw,
			meta: { type: "decoded", data: { ...(beachRaw.meta as { data: object }).data, name: "sea.jpg" } }
		} as File)

		queryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid: PHOTOS }), [
			...listing(PHOTOS).filter(item => item.data.uuid !== beachRaw.uuid),
			renamed
		])

		expect(await call.execute()).toMatchObject({
			ok: true,
			result: { renamed: 1, skipped: [{ name: "beach.jpg", reason: "changed since the card showed it" }] }
		})
		expect(sdk.renameFile).toHaveBeenCalledOnce()
	})

	it("plans a repeated request afresh, never from the plan an earlier card held", async () => {
		await run("rename_by_pattern", { scope: "d1", kind: "image", scheme: "add_suffix", text: "_x" })
		// hike.jpg is gone by the time the user asks again.
		sdk.listDirectory.mockResolvedValue({ dirs: [oldRaw], files: [beachRaw, notesRaw] })

		const again = await run("rename_by_pattern", { scope: "d1", kind: "image", scheme: "add_suffix", text: "_x" })

		expect(again.preview?.batch?.changes).toEqual([{ from: "beach.jpg", to: "beach_x.jpg", suffixed: false }])
	})

	it("never runs without the plan its card showed", async () => {
		const call = await run("rename_by_pattern", { scope: "d1", kind: "image", scheme: "add_suffix", text: "_x" })

		executor.reset()

		expect(await call.execute()).toMatchObject({ ok: false })
		expect(sdk.renameFile).not.toHaveBeenCalled()
	})
})

describe("listing reads", () => {
	it("plans from the listings the drive holds current, reading none again", async () => {
		// The user has Photos and its 2023 subdirectory open under a live socket: the drive UI keeps those listings as
		// they are, with every change since patched in.
		socketAuthenticated()

		for (const uuid of [PHOTOS, OLD]) {
			queryClient.removeQueries({ queryKey: driveListingQueryKey({ variant: "drive", uuid }) })
			await queryClient.query(driveListingQueryOptions("drive", uuid))
		}

		sdk.listDirectory.mockClear()

		const rename = await run("rename_by_pattern", { scope: "d1", kind: "image", scheme: "date_prefix" })

		expect(await rename.execute()).toMatchObject({ ok: true })

		const sort = await run("organize_by_date", { scope: "d1", by: "year" })

		expect(sort.preview).toMatchObject({ action: "organize-by-date" })
		expect(sdk.listDirectory).not.toHaveBeenCalled()
		socketDropped()
	})
})

describe("organize_by_date", () => {
	it("reuses an existing subdirectory, creates the missing one, and renames a move that would clash", async () => {
		const call = await run("organize_by_date", { scope: "d1", by: "year", kind: "any" })

		expect(call.preview).toMatchObject({
			action: "organize-by-date",
			destination: "/Photos",
			batch: {
				rule: { by: "year" },
				groups: [
					{ directory: "2023", isNew: false, items: [{ from: "beach.jpg", to: "beach (2).jpg" }] },
					{ directory: "2024", isNew: true, items: [{ from: "hike.jpg" }, { from: "notes.txt" }] }
				]
			}
		})
		expect(sdk.createDirectory).not.toHaveBeenCalled()

		expect(await call.execute()).toMatchObject({ ok: true, result: { moved: 3, created: 1 } })
		expect(sdk.createDirectory).toHaveBeenCalledOnce()
		expect(sdk.createDirectory).toHaveBeenCalledWith(PHOTOS, "2024")
		expect(sdk.renameFile).toHaveBeenCalledWith(expect.objectContaining({ uuid: beachRaw.uuid }), "beach (2).jpg")
		expect(sdk.moveFile).toHaveBeenCalledWith(expect.objectContaining({ uuid: beachRaw.uuid }), OLD)
		expect(sdk.moveFile).toHaveBeenCalledWith(expect.objectContaining({ uuid: hikeRaw.uuid }), testUuid("new-2024"))
	})
})
