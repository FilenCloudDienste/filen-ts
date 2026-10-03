// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { onlineManager, QueryClientProvider } from "@tanstack/react-query"
import type { AnyFile } from "@filen/sdk-rs"
import type { JobDestination } from "@filen/shared"
import type { ArchiveNameInfo } from "@/workers/sdk.worker"
import type { ExtractJobRequest } from "@/features/drive/lib/archiveJobs.logic"
import "@/lib/i18n"

// Where the browser's extracts go: the menu's entries per source, the request each pick starts (with the
// listing's password), and the hard-link dialog for links whose files lie outside the directory shown.

const { openListingSession, startExtractWithCard } = vi.hoisted(() => ({
	openListingSession: vi.fn(),
	startExtractWithCard: vi.fn<(request: Omit<ExtractJobRequest, "id">, password: string | undefined) => string>(() => "job")
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", async () => {
	const { QueryClient: Client } = await import("@tanstack/react-query")
	return { queryClient: new Client({ defaultOptions: { queries: { retry: false } } }) }
})
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), custom: vi.fn(), dismiss: vi.fn() } }))
vi.mock("@/features/transfers/lib/archiveToast", () => ({ startExtractWithCard }))
vi.mock("@/features/archive/lib/listingSession", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/archive/lib/listingSession")>()),
	openListingSession
}))
vi.mock("@/features/drive/queries/drive", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/queries/drive")>()),
	useDirectoryTreeChildrenQuery: () => ({ status: "success", data: [] }),
	cachedDirectoryName: (uuid: string) => (uuid === "parent-dir" ? "Holiday" : undefined)
}))
// The picker browses the drive; here it hands back one directory at once.
vi.mock("@/features/drive/components/moveTargetDialog", () => ({
	MoveTargetDialog: ({ onPick }: { onPick: (destination: JobDestination) => void }) => (
		<button
			type="button"
			onClick={() => {
				onPick({ uuid: "picked", name: "Picked" })
			}}
		>
			pick
		</button>
	)
}))

import { queryClient } from "@/queries/client"
import type { EntryStore } from "@/features/archive/lib/entryStore"
import type { ArchiveSource } from "@/features/archive/lib/archiveSource"
import type { ListingPhase, ListingSession, ListingSnapshot, ListSummary } from "@/features/archive/lib/listingSession"
import { ArchiveSourceBrowser } from "@/features/archive/components/archiveBrowser"
import { ArchiveExtractMenu } from "@/features/archive/components/archiveExtractMenu"
import { createEntryStore } from "@/features/archive/lib/entryStore"
import { ENTRY_FLAG } from "@/lib/sdk/archiveListing"
import { packEntries, storeOf, TEST_ARCHIVE, type EntrySpec } from "@/tests/support/archiveEntries"

const TAR_INFO: ArchiveNameInfo = { format: { type: "tar", codec: undefined }, defaultName: "photos" }

const SUMMARY: ListSummary = {
	format: { type: "tar", codec: undefined },
	password: "notNeeded",
	totals: { entries: 0, dirs: 0, files: 0, bytes: 0, skipped: 0, bytesSkipped: 0 },
	undelivered: 0,
	duplicates: null,
	unaccountedBytes: 0,
	verifying: false,
	verifyWaiting: false,
	verifyError: null
}

const FILE = { uuid: TEST_ARCHIVE } as unknown as AnyFile

function source(ownParent: string | null | undefined): ArchiveSource {
	return { file: FILE, uuid: TEST_ARCHIVE, name: "photos.tar", size: 1024, ownParent }
}

// The session's commands, each a spy.
function sessionSpies() {
	return {
		start: vi.fn<() => void>(),
		stop: vi.fn<() => void>(),
		retry: vi.fn<() => void>(),
		submitPassword: vi.fn<(password: string) => void>(),
		rememberDirPath: vi.fn<(path: string) => void>(),
		dispose: vi.fn<() => void>()
	}
}

interface Fake {
	session: ListingSession & ReturnType<typeof sessionSpies>
	set: (phase: ListingPhase, password?: string) => void
}

function fakeSession(phase: ListingPhase, store: EntryStore, password?: string): Fake {
	const listeners = new Set<() => void>()
	let snapshot: ListingSnapshot = { phase, store, version: 0, info: TAR_INFO }
	let accepted = password

	return {
		session: {
			getSnapshot: () => snapshot,
			subscribe: listener => {
				listeners.add(listener)

				return () => {
					listeners.delete(listener)
				}
			},
			...sessionSpies(),
			password: () => accepted,
			restoredDirPath: () => ""
		},
		set: (next, nextPassword) => {
			snapshot = { ...snapshot, phase: next, version: snapshot.version + 1 }
			accepted = nextPassword

			act(() => {
				for (const listener of [...listeners]) {
					listener()
				}
			})
		}
	}
}

function mockListViewport(): void {
	const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")

	Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
		configurable: true,
		get(this: HTMLElement) {
			return this.getAttribute("role") === "listbox" ? 360 : 0
		}
	})
	onTestFinished(() => {
		if (original === undefined) {
			Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight")
		} else {
			Object.defineProperty(HTMLElement.prototype, "offsetHeight", original)
		}
	})
}

// `ownParent` undefined: the archive has no directory of the user's own (no default, which undefined
// would take).
function show(fake: Fake, ownParent: string | null | undefined) {
	openListingSession.mockReturnValue(fake.session)

	return render(
		<QueryClientProvider client={queryClient}>
			<ArchiveSourceBrowser source={source(ownParent)} />
		</QueryClientProvider>
	)
}

function list(): HTMLElement {
	return screen.getByRole("listbox")
}

function press(key: string, init: Partial<KeyboardEventInit> = {}): void {
	act(() => {
		fireEvent.keyDown(list(), { key, ...init })
	})
}

function clickRow(name: string): void {
	const row = within(list())
		.getAllByRole("option")
		.find(option => option.textContent.includes(name))

	if (row === undefined) {
		throw new Error(`no row "${name}"`)
	}

	fireEvent.click(row, { detail: 1 })
}

async function openMenu(name: string): Promise<void> {
	const trigger = screen.getByRole("button", { name })

	await act(async () => {
		trigger.focus()
		fireEvent.keyDown(trigger, { key: "ArrowDown" })
		await Promise.resolve()
	})
}

function entries(): string[] {
	return screen.getAllByRole("menuitem").map(item => item.textContent.trim())
}

async function pick(name: string): Promise<void> {
	await act(async () => {
		fireEvent.click(screen.getByRole("menuitem", { name }))
		await Promise.resolve()
	})
}

function started(): { request: Omit<ExtractJobRequest, "id">; password: string | undefined } {
	const call = startExtractWithCard.mock.calls.at(-1)

	if (call === undefined) {
		throw new Error("no extract started")
	}

	return { request: call[0], password: call[1] }
}

const TREE = ["docs/a.txt", "docs/b.txt", "readme.md"]

beforeEach(() => {
	onlineManager.setOnline(true)
	mockListViewport()
})

afterEach(() => {
	cleanup()
})

describe("ArchiveExtractMenu", () => {
	function menu(ownParent: string | null | undefined, newFolderName: string | null) {
		render(
			<QueryClientProvider client={queryClient}>
				<ArchiveExtractMenu
					source={source(ownParent)}
					newFolderName={newFolderName}
					label="Extract"
					variant="default"
					disabled={false}
					onPick={vi.fn()}
				/>
			</QueryClientProvider>
		)
	}

	it("offers next to the archive only where the archive has a directory of the user's own", async () => {
		menu("parent-dir", "photos")
		await openMenu("Extract")

		expect(entries()).toEqual([
			"Extract to “photos/” next to the archive",
			"Extract next to the archive",
			"Extract to",
			"Choose destination…"
		])
	})

	it("hides next to the archive for a shared, linked or trashed archive", async () => {
		menu(undefined, "photos")
		await openMenu("Extract")

		expect(entries()).toEqual(["Extract to", "Choose destination…"])
	})

	it("leaves out the new directory for a single compressed file", async () => {
		menu(null, null)
		await openMenu("Extract")

		expect(entries()).toEqual(["Extract next to the archive", "Extract to", "Choose destination…"])
	})
})

describe("ArchiveSourceBrowser extracts", () => {
	it("extracts the selection into a new directory next to the archive, named after it at the root", async () => {
		show(fakeSession({ type: "done", summary: SUMMARY }, storeOf(TREE)), null)
		clickRow("readme.md")
		await openMenu("Extract selected")
		await pick("Extract to “photos/” next to the archive")

		const { request, password } = started()

		expect(request).toMatchObject({
			archive: { file: FILE, uuid: TEST_ARCHIVE, name: "photos.tar" },
			destination: { uuid: null, name: "Cloud Drive" },
			root: { type: "newFolder", name: "photos" },
			calls: [{ type: "entries", entries: [{ archive: TEST_ARCHIVE, index: 2 }], base: "", destination: { uuid: null } }],
			basis: { type: "planned", bytes: 1, files: 1 },
			skipMacMetadata: true,
			dispose: null,
			formatHint: "tar"
		})
		expect(password).toBeUndefined()
	})

	it("takes a subdirectory's paths relative to it, its new directory named after it", async () => {
		show(fakeSession({ type: "done", summary: SUMMARY }, storeOf(TREE)), "parent-dir")
		press("Enter")
		press("a", { ctrlKey: true })
		await openMenu("Extract selected")
		await pick("Extract to “docs/” next to the archive")

		expect(started().request).toMatchObject({
			destination: { uuid: "parent-dir", name: "Holiday" },
			root: { type: "newFolder", name: "docs" },
			calls: [{ type: "entries", base: "docs" }],
			basis: { type: "planned", bytes: 2, files: 2 }
		})
	})

	it("extracts straight next to the archive, or to a directory picked in the tree or the picker", async () => {
		show(fakeSession({ type: "done", summary: SUMMARY }, storeOf(TREE)), null)
		clickRow("readme.md")
		await openMenu("Extract selected")
		await pick("Extract next to the archive")

		expect(started().request).toMatchObject({ root: { type: "destination" }, destination: { uuid: null } })

		await openMenu("Extract selected")
		await act(async () => {
			const trigger = screen.getByRole("menuitem", { name: "Extract to" })

			trigger.focus()
			fireEvent.keyDown(trigger, { key: "ArrowRight" })
			await Promise.resolve()
		})
		await pick("Extract here")

		expect(started().request).toMatchObject({
			destination: { uuid: null, name: "Cloud Drive" },
			root: { type: "newFolder", name: "photos" }
		})

		await openMenu("Extract selected")
		await pick("Choose destination…")
		fireEvent.click(screen.getByRole("button", { name: "pick" }))

		expect(started().request).toMatchObject({ destination: { uuid: "picked", name: "Picked" } })
	})

	it("extracts everything with Extract all, passing on the password the listing accepted", () => {
		show(fakeSession({ type: "done", summary: SUMMARY }, storeOf(TREE), "secret"), null)
		fireEvent.click(screen.getByRole("button", { name: "Extract all" }))

		const { request, password } = started()

		expect(request).toMatchObject({
			calls: [{ type: "all" }],
			basis: { type: "archiveRead" },
			root: { type: "newFolder" },
			rowName: "photos"
		})
		expect(password).toBe("secret")
	})

	it("stops a running listing before Extract all, which needs the archive slot", () => {
		const fake = fakeSession(
			{ type: "reading", bytesRead: 1, archiveBytes: 9, entries: 3, bytesPerSecond: null, etaMs: null },
			storeOf(TREE)
		)

		show(fake, null)
		fireEvent.click(screen.getByRole("button", { name: "Extract all" }))

		expect(fake.session.stop).toHaveBeenCalledTimes(1)
		expect(started().request).toMatchObject({ calls: [{ type: "all" }] })
	})

	it("opens Extract all's menu at once for an archive with no directory of the user's own", async () => {
		show(fakeSession({ type: "done", summary: SUMMARY }, storeOf(TREE)), undefined)
		await openMenu("Extract all")

		expect(entries()).toEqual(["Extract to", "Choose destination…"])
		expect(startExtractWithCard).not.toHaveBeenCalled()
	})
})

describe("encrypted entries", () => {
	// readme.md encrypted, the listing told it needs a password it doesn't have.
	function encryptedStore(): EntryStore {
		const store = createEntryStore()

		for (const batch of packEntries(TREE)) {
			batch.flags[2] = ENTRY_FLAG.encrypted
			store.append(batch)
		}

		return store
	}

	const REQUIRED: ListingPhase = { type: "done", summary: { ...SUMMARY, password: "required" } }

	async function extractEncrypted(fake: Fake): Promise<void> {
		show(fake, null)
		clickRow("readme.md")
		await openMenu("Extract selected")
		await pick("Extract next to the archive")
	}

	it("asks for the password and checks it before extracting, passing it on", async () => {
		const fake = fakeSession(REQUIRED, encryptedStore())

		await extractEncrypted(fake)

		expect(startExtractWithCard).not.toHaveBeenCalled()

		fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "secret" } })
		fireEvent.click(screen.getByRole("button", { name: "Unlock" }))

		expect(fake.session.submitPassword).toHaveBeenCalledWith("secret")

		fake.set({ type: "done", summary: { ...SUMMARY, password: "required", verifying: true } })

		expect(startExtractWithCard).not.toHaveBeenCalled()

		fake.set({ type: "done", summary: { ...SUMMARY, password: "right" } }, "secret")

		expect(started()).toMatchObject({ request: { root: { type: "destination" } }, password: "secret" })
	})

	it("asks again after a wrong password", async () => {
		const fake = fakeSession(REQUIRED, encryptedStore())

		await extractEncrypted(fake)
		fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "nope" } })
		fireEvent.click(screen.getByRole("button", { name: "Unlock" }))
		fake.set({ type: "done", summary: { ...SUMMARY, password: "wrong" } })

		expect(startExtractWithCard).not.toHaveBeenCalled()
		expect(await screen.findByText("That password didn't open “photos.tar”. Try again.")).toBeTruthy()
	})

	it("drops the waiting extract when the check is cancelled, asking nothing again", async () => {
		const fake = fakeSession(REQUIRED, encryptedStore())

		await extractEncrypted(fake)
		fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "secret" } })
		fireEvent.click(screen.getByRole("button", { name: "Unlock" }))
		fake.set({ type: "done", summary: { ...SUMMARY, password: "required", verifying: true, verifyWaiting: true } })
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

		expect(fake.session.stop).toHaveBeenCalledTimes(1)

		fake.set({ type: "done", summary: { ...SUMMARY, password: "required" } })

		expect(startExtractWithCard).not.toHaveBeenCalled()
		expect(screen.queryByLabelText("Password")).toBeNull()
	})

	it("needs no password for entries that aren't encrypted", async () => {
		await extractEncrypted(fakeSession(REQUIRED, storeOf(TREE)))

		expect(startExtractWithCard).toHaveBeenCalledTimes(1)
	})
})

describe("hard links outside the directory shown", () => {
	const LINKED = [
		"a/f.txt",
		"b/g.txt",
		{ path: "b/h", kind: { type: "hardlink", target: "a/f.txt", targetId: { archive: TEST_ARCHIVE, index: 0 } } }
	] satisfies (EntrySpec | string)[]

	async function extractLinked(): Promise<void> {
		show(fakeSession({ type: "done", summary: SUMMARY }, storeOf(LINKED)), null)
		press("End")
		press("Enter")
		press("a", { ctrlKey: true })
		await openMenu("Extract selected")
		await pick("Extract to “b/” next to the archive")
	}

	it("asks before extracting, and can leave those links out", async () => {
		await extractLinked()

		expect(startExtractWithCard).not.toHaveBeenCalled()
		expect(
			screen.getByText("1 selected hard link points to a file outside “b”, which an extract from here can't include.")
		).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Leave those links out" }))

		expect(started().request).toMatchObject({
			root: { type: "newFolder", name: "b" },
			calls: [{ type: "entries", entries: [{ archive: TEST_ARCHIVE, index: 1 }], base: "b" }]
		})
	})

	it("can extract from the directory holding both instead", async () => {
		await extractLinked()

		fireEvent.click(screen.getByRole("button", { name: "Extract from “photos.tar” instead" }))

		const { request } = started()

		expect(request).toMatchObject({ root: { type: "newFolder", name: "photos" }, calls: [{ type: "entries", base: "" }] })
		const call = request.calls[0]

		expect(call?.type === "entries" ? call.entries.map(entry => entry.index).sort((x, y) => x - y) : null).toEqual([0, 1, 2])
	})

	it("cancels without extracting", async () => {
		await extractLinked()

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

		expect(startExtractWithCard).not.toHaveBeenCalled()
		expect(screen.queryByText(/selected hard link/)).toBeNull()
	})
})
