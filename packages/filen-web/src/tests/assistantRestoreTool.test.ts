// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Dir, File, Note, UserInfo } from "@filen/sdk-rs"
import { assistantToolByName } from "@filen/shared/assistant"
import { testUuid } from "@/tests/support/uuid"

// The SDK below the user's own action modules: a restore must reach it only through them.
const sdk = vi.hoisted(() => ({
	listDirectory: vi.fn(),
	getItemInfo: vi.fn(),
	listNotes: vi.fn(),
	restoreFile: vi.fn(),
	restoreDirectory: vi.fn(),
	restoreNote: vi.fn(),
	moveFile: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: sdk }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }))
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() }) }))

import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { CONTACTS_QUERY_KEY } from "@/features/contacts/queries/contacts"
import { driveListingQueryKey } from "@/features/drive/queries/drive"
import { narrowItem } from "@/features/drive/lib/item"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { createAssistantToolExecutor } from "@/features/assistant/tools/executor"
import { buildProposal } from "@/features/assistant/loop/executorAdapter"
import type { ToolExecutor } from "@/features/assistant/runtime/executor"

const ROOT = testUuid("root")
const DOCS = testUuid("docs")
const TIMESTAMP = 1_700_000_000_000n

const docsRaw = {
	uuid: DOCS,
	parent: ROOT,
	color: "default",
	timestamp: TIMESTAMP,
	favorited: false,
	meta: { type: "decoded", data: { name: "Docs" } }
} as Dir

function rawFile(uuid: string, name: string, parent: string): File {
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
		meta: { type: "decoded", data: { name, mime: "application/pdf", modified: TIMESTAMP, size: 64n, key: "key", version: 2 } }
	} as File
}

function note(uuid: string, title: string, trash: boolean): Note {
	return {
		uuid,
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags: [],
		noteType: "text",
		encryptionKey: "key",
		title,
		trash,
		archive: false,
		createdTimestamp: TIMESTAMP,
		editedTimestamp: TIMESTAMP,
		participants: []
	} as unknown as Note
}

// In the trash: a draft from Docs and one from a directory the app holds no row of.
const draftRaw = rawFile(testUuid("draft"), "old_draft.docx", DOCS)
const strayRaw = rawFile(testUuid("stray"), "stray.pdf", testUuid("gone"))
const liveRaw = rawFile(testUuid("live"), "live.pdf", ROOT)
const packing = note(testUuid("packing"), "Packing list", true)
const groceries = note(testUuid("groceries"), "Groceries", false)

let executor: ToolExecutor

function tool(name: string) {
	const found = assistantToolByName(name)

	if (found === undefined) {
		throw new Error(`no tool ${name}`)
	}

	return found
}

function execute(name: string, args: Record<string, unknown>, confirmed = false) {
	return executor.execute({ callId: name, tool: tool(name), args, confirmed, signal: new AbortController().signal })
}

beforeEach(async () => {
	vi.clearAllMocks()
	queryClient.clear()
	queryClient.setQueryData<Partial<UserInfo>>(ACCOUNT_QUERY_KEY, { id: 1n, rootDirUuid: ROOT })
	queryClient.setQueryData(CONTACTS_QUERY_KEY, { contacts: [], blocked: [] })
	queryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid: null }), [narrowItem(docsRaw), narrowItem(liveRaw)])
	sdk.listDirectory.mockImplementation((target: { kind: string }) =>
		Promise.resolve(
			target.kind === "trash"
				? { dirs: [], files: [draftRaw, strayRaw] }
				: target.kind === "root"
					? { dirs: [docsRaw], files: [liveRaw] }
					: { dirs: [], files: [] }
		)
	)
	sdk.getItemInfo.mockResolvedValue({ path: "/Docs", ancestors: [] })
	sdk.listNotes.mockResolvedValue([packing, groceries])
	sdk.restoreFile.mockImplementation((file: File) => Promise.resolve(file))
	sdk.restoreNote.mockImplementation((target: Note) => Promise.resolve({ ...target, trash: false }))
	useDriveStore.setState({ selectedItems: [], pendingReveal: null })
	executor = createAssistantToolExecutor()
	// The model listed the trash (f1 old_draft.docx, f2 stray.pdf), the trashed notes (n1 Packing list), the root.
	await execute("list_section", { section: "trash" })
	await execute("list_notes", { only: "trashed" })
	await execute("list_directory", { handle: "d0" })
})

describe("restore_items", () => {
	it("lists every item with where it returns, and restores nothing until confirmed", async () => {
		const args = { handles: ["f1", "f2", "n1"] }
		const checked = await executor.check({ callId: "c", tool: tool("restore_items"), args })

		expect(checked).toMatchObject({ ok: true })

		const preview = await executor.preview({ tool: tool("restore_items"), args })

		if (!preview.ok) {
			throw new Error(preview.error)
		}

		expect(buildProposal({ id: "p", tool: tool("restore_items"), args, preview })).toMatchObject({
			action: "restore",
			targets: [
				{ handle: "f1", name: "old_draft.docx", where: "/Docs" },
				{ handle: "f2", name: "stray.pdf" },
				{ handle: "n1", name: "Packing list" }
			]
		})
		expect(await execute("restore_items", args)).toMatchObject({ ok: false, error: "This needs the user's confirmation first" })
		expect(sdk.restoreFile).not.toHaveBeenCalled()
		expect(sdk.restoreNote).not.toHaveBeenCalled()
	})

	it("restores trashed files and notes through the trash screen's and the notes menu's own actions", async () => {
		expect(await execute("restore_items", { handles: ["f1", "n1"] }, true)).toMatchObject({
			ok: true,
			result: { restored: ["old_draft.docx", "Packing list"] }
		})
		expect(sdk.restoreFile).toHaveBeenCalledWith(expect.objectContaining({ uuid: draftRaw.uuid }))
		expect(sdk.restoreNote).toHaveBeenCalledWith(expect.objectContaining({ uuid: packing.uuid }))
	})

	it("refuses an item that is not in the trash", async () => {
		const live = await execute("restore_items", { handles: ["f3"] }, true)

		expect(live).toMatchObject({ ok: false, error: '"live.pdf" is not in the trash' })
		await execute("list_notes", {})
		expect(await executor.check({ callId: "c", tool: tool("restore_items"), args: { handles: ["n2"] } })).toMatchObject({
			ok: false,
			error: '"Groceries" is not in the trash'
		})
		expect(sdk.restoreFile).not.toHaveBeenCalled()
		expect(sdk.restoreNote).not.toHaveBeenCalled()
	})

	it("still keeps every other write out of the trash", async () => {
		expect(await executor.check({ callId: "c", tool: tool("move_items"), args: { handles: ["f1"], destination: "d0" } })).toMatchObject(
			{
				ok: false,
				error: '"old_draft.docx" is in the trash; only the user can restore or change it, in the app'
			}
		)
	})
})
