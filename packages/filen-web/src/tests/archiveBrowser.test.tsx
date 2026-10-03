// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { onlineManager, QueryClientProvider } from "@tanstack/react-query"
import type { AnyFile } from "@filen/sdk-rs"
import type { ErrorDTO } from "@/lib/sdk/errors"
import type { ArchiveNameInfo } from "@/workers/sdk.worker"
import "@/lib/i18n"

// The browser against a scripted listing session: every state it shows, the list's key table (Left and
// Right left to the overlay, Escape kept while something is selected) and navigation clearing the
// selection.

const { openListingSession, startExtractWithCard } = vi.hoisted(() => ({
	openListingSession: vi.fn(),
	startExtractWithCard: vi.fn<(request: unknown, password: string | undefined) => string>(() => "job")
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

import { queryClient } from "@/queries/client"
import type { EntryStore } from "@/features/archive/lib/entryStore"
import { archiveSourceOf, type ArchiveSource } from "@/features/archive/lib/archiveSource"
import { narrowItem } from "@/features/drive/lib/item"
import { testUuid } from "@/tests/support/uuid"
import type { ListingPhase, ListingSession, ListingSnapshot, ListSummary } from "@/features/archive/lib/listingSession"
import { createListingCache, ListingCacheContext } from "@/features/archive/lib/listingCache"
import { ArchiveSourceBrowser } from "@/features/archive/components/archiveBrowser"
import { PreviewDownloadableProvider } from "@/features/preview/lib/accessMode"
import { useDriveJobsStore } from "@/features/transfers/store/useDriveJobsStore"
import { extractJob } from "@/tests/support/archiveJobFixtures"
import { storeOf, TEST_ARCHIVE } from "@/tests/support/archiveEntries"

const SUMMARY: ListSummary = {
	format: { type: "zip" },
	password: "notNeeded",
	totals: { entries: 0, dirs: 0, files: 0, bytes: 0, skipped: 0, bytesSkipped: 0 },
	undelivered: 0,
	duplicates: null,
	unaccountedBytes: 0,
	verifying: false,
	verifyWaiting: false,
	verifyError: null
}

const ZIP_INFO: ArchiveNameInfo = { format: { type: "zip" }, defaultName: "photos" }

const SOURCE: ArchiveSource = {
	file: { uuid: TEST_ARCHIVE } as unknown as AnyFile,
	uuid: TEST_ARCHIVE,
	name: "photos.zip",
	size: 100 * 1024 * 1024,
	ownParent: null
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

interface FakeSession {
	session: ListingSession & ReturnType<typeof sessionSpies>
	set: (phase: ListingPhase, store?: EntryStore) => void
}

function fakeSession(phase: ListingPhase, store: EntryStore = storeOf([]), info: ArchiveNameInfo = ZIP_INFO): FakeSession {
	const listeners = new Set<() => void>()
	let snapshot: ListingSnapshot = { phase, store, version: 0, info }
	const session = {
		getSnapshot: () => snapshot,
		subscribe: (listener: () => void) => {
			listeners.add(listener)

			return () => {
				listeners.delete(listener)
			}
		},
		...sessionSpies(),
		password: () => undefined,
		restoredDirPath: () => ""
	}

	return {
		session,
		set: (next, nextStore = snapshot.store) => {
			snapshot = { ...snapshot, phase: next, store: nextStore, version: snapshot.version + 1 }

			act(() => {
				for (const listener of listeners) {
					listener()
				}
			})
		}
	}
}

function done(summary: Partial<ListSummary> = {}): ListingPhase {
	return { type: "done", summary: { ...SUMMARY, ...summary } }
}

function error(kind: string): ErrorDTO {
	return { species: "sdk", kind, label: kind, message: kind }
}

// The virtualizer sizes its viewport off offsetHeight, which jsdom leaves at 0: a 360px list.
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

const parentKeyDown = vi.fn()

function show(fake: FakeSession, downloadable = true, source: ArchiveSource = SOURCE) {
	openListingSession.mockReturnValue(fake.session)

	return render(
		<QueryClientProvider client={queryClient}>
			<PreviewDownloadableProvider downloadable={downloadable}>
				{/* Stands in for the overlay's own handler, which pages on Left/Right. */}
				<div onKeyDown={parentKeyDown}>
					<ArchiveSourceBrowser source={source} />
				</div>
			</PreviewDownloadableProvider>
		</QueryClientProvider>
	)
}

async function wait(ms: number): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, ms))
	})
}

function list(): HTMLElement {
	return screen.getByRole("listbox")
}

function options(): HTMLElement[] {
	return within(list()).getAllByRole("option")
}

function selectedNames(): string[] {
	return options()
		.filter(option => option.getAttribute("aria-selected") === "true")
		.map(option => option.textContent)
}

function cursorName(): string | null {
	const id = list().getAttribute("aria-activedescendant")

	return id === null ? null : (document.getElementById(id)?.textContent ?? null)
}

// Dispatched on the listbox itself; false when a handler prevented its default.
function press(key: string, init: Partial<KeyboardEventInit> = {}): boolean {
	let notPrevented = true

	act(() => {
		notPrevented = fireEvent.keyDown(list(), { key, ...init })
	})

	return notPrevented
}

const TREE = ["docs/a.txt", "docs/b.txt", "docs/deep/c.txt", "readme.md", "z.bin"]

beforeEach(() => {
	onlineManager.setOnline(true)
	useDriveJobsStore.setState({ jobs: {}, cancelPromptId: null, passwordPromptId: null, reportJobId: null })
})

afterEach(() => {
	cleanup()
})

describe("ArchiveSourceBrowser states", () => {
	it("opens the session on mount and disposes it on unmount", () => {
		const fake = fakeSession(done(), storeOf(TREE))
		const view = show(fake)

		expect(openListingSession).toHaveBeenCalledTimes(1)
		expect(fake.session.dispose).not.toHaveBeenCalled()

		view.unmount()

		expect(fake.session.dispose).toHaveBeenCalledTimes(1)
	})

	it("shows the spinner only once resolving takes 300 ms", async () => {
		show(fakeSession({ type: "resolving" }))

		expect(screen.queryByRole("status")).toBeNull()

		await wait(350)

		expect(screen.getByRole("status")).toBeTruthy()
	})

	it("gates a large tarball until Browse contents", () => {
		const fake = fakeSession({ type: "gate", format: { type: "tar", codec: "gzip" } })

		show(fake)

		expect(screen.getByText("Listing its contents reads the whole 100 MiB archive.")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Browse contents" }))

		expect(fake.session.start).toHaveBeenCalledTimes(1)
		expect(screen.getByRole("button", { name: "Extract all" })).toBeTruthy()
	})

	it("waits for the archive slot, naming a paused holder, and cancels", () => {
		const fake = fakeSession({ type: "waiting" })

		show(fake)

		expect(screen.getByText("Waiting for another archive job")).toBeTruthy()
		expect(screen.queryByText(/A paused job is holding it/)).toBeNull()

		act(() => {
			useDriveJobsStore.setState({ jobs: { held: extractJob({ paused: true, phase: "extracting" }, "held") } })
		})

		expect(screen.getByText(/A paused job is holding it/)).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

		expect(fake.session.stop).toHaveBeenCalledTimes(1)
	})

	it("shows a tar's reading progress after 400 ms, browsable meanwhile, with Stop", async () => {
		mockListViewport()

		const fake = fakeSession(
			{ type: "reading", bytesRead: 25, archiveBytes: 100, entries: 2, bytesPerSecond: 10, etaMs: 7500 },
			storeOf(["a.txt", "b.txt"]),
			{ format: { type: "tar", codec: undefined }, defaultName: "photos" }
		)

		show(fake)

		expect(options()).toHaveLength(2)
		expect(screen.queryByText("Reading the archive…")).toBeNull()

		await wait(450)

		expect(screen.getByText(/2 entries · 25 B of 100 B/)).toBeTruthy()
		expect(screen.getByText(/0:08 left/)).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Stop" }))

		expect(fake.session.stop).toHaveBeenCalledTimes(1)
	})

	it("asks for the password before anything is listed", async () => {
		const fake = fakeSession({ type: "needsPassword", wrong: false })

		show(fake)

		expect(screen.getByText("This archive's contents are encrypted.")).toBeTruthy()

		const field = await screen.findByLabelText("Password")

		fireEvent.change(field, { target: { value: "secret" } })
		fireEvent.click(screen.getByRole("button", { name: "Unlock" }))

		expect(fake.session.submitPassword).toHaveBeenCalledWith("secret")
	})

	it("offers the password from a banner when some entries are encrypted, and says when it was wrong", () => {
		mockListViewport()

		const fake = fakeSession(done({ password: "required" }), storeOf(TREE))

		show(fake)

		expect(screen.getByText("Some entries are encrypted. Extracting them needs the password.")).toBeTruthy()

		fake.set(done({ password: "wrong" }))

		expect(screen.getByText("That password didn't open the encrypted entries.")).toBeTruthy()

		fake.set(done({ password: "wrong", verifying: true }))

		expect(screen.getByText("Checking the password…")).toBeTruthy()
	})

	it("checks a password with a Cancel, saying while it waits for the archive slot", () => {
		mockListViewport()

		const fake = fakeSession(done({ password: "required", verifying: true }), storeOf(TREE))

		show(fake)

		expect(screen.getByText("Checking the password…")).toBeTruthy()

		fake.set(done({ password: "required", verifying: true, verifyWaiting: true }))

		expect(screen.getByText("Waiting for another archive job to check the password")).toBeTruthy()

		act(() => {
			useDriveJobsStore.setState({ jobs: { held: extractJob({ paused: true, phase: "extracting" }, "held") } })
		})

		expect(screen.getByText(/A paused job is holding it/)).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

		expect(fake.session.stop).toHaveBeenCalledTimes(1)
	})

	it("offers to list again, not an empty archive, when a listing was cancelled before reading anything", () => {
		const fake = fakeSession({ type: "gate", format: { type: "zip" } })

		show(fake)

		expect(screen.getByText("Its contents weren't listed.")).toBeTruthy()
		expect(screen.queryByText("This archive is empty.")).toBeNull()

		fireEvent.click(screen.getByRole("button", { name: "Browse contents" }))

		expect(fake.session.start).toHaveBeenCalledTimes(1)
	})

	it("says where a stopped listing ended and lists again", () => {
		mockListViewport()

		const fake = fakeSession({ type: "stopped", summary: SUMMARY }, storeOf(["a.txt", "b.txt"]))

		show(fake)

		expect(screen.getByText("Listing stopped after 2 entries.")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "List again" }))

		expect(fake.session.retry).toHaveBeenCalledTimes(1)
	})

	it("heads a failure by its kind, keeping the entries a damaged archive gave", () => {
		mockListViewport()

		const fake = fakeSession({ type: "failed", error: error("ArchiveCorrupt"), summary: SUMMARY }, storeOf(["a.txt"]))

		show(fake)

		expect(screen.getByText("This archive is damaged.")).toBeTruthy()
		expect(screen.getByText(/Showing the 1 entry read before the damage/)).toBeTruthy()
		expect(options()).toHaveLength(1)
	})

	it("fails in place of the list when nothing was read, with Try again", () => {
		const fake = fakeSession({ type: "failed", error: error("ArchiveTooLarge"), summary: null })

		show(fake)

		expect(screen.getByText("This archive is too large to list in the browser.")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Try again" }))

		expect(fake.session.retry).toHaveBeenCalledTimes(1)
	})

	it("notes undelivered entries and duplicate paths", () => {
		mockListViewport()
		show(fakeSession(done({ undelivered: 3, duplicates: { names: ["a.txt"], count: 1 } }), storeOf(["a.txt", "a.txt"])))

		expect(screen.getByText("3 entries couldn't be shown; Extract all still extracts everything.")).toBeTruthy()
		expect(screen.getByText("1 entry is left out because a later entry has the same name.")).toBeTruthy()
	})

	it("says when the archive is empty", () => {
		show(fakeSession(done()))

		expect(screen.getByText("This archive is empty.")).toBeTruthy()
	})

	it("disables extracting while offline", () => {
		mockListViewport()
		onlineManager.setOnline(false)
		show(fakeSession(done(), storeOf(TREE)))

		expect(screen.getByRole("button", { name: "Extract all" }).hasAttribute("disabled")).toBe(true)
		expect(screen.getByRole("button", { name: "Extract selected" }).hasAttribute("disabled")).toBe(true)
	})

	it("browses a link that allows no downloads but extracts nothing, saying why", () => {
		const reason = "The link's owner doesn't allow downloads, so nothing can be extracted from it."

		mockListViewport()
		show(fakeSession(done(), storeOf(TREE)), false)

		expect(options()).toHaveLength(3)

		press(" ")

		expect(selectedNames()).toHaveLength(1)
		expect(screen.getByText(reason)).toBeTruthy()

		for (const name of ["Extract all", "Extract selected"]) {
			const button = screen.getByRole("button", { name })

			expect(button.hasAttribute("disabled")).toBe(true)
			expect(button.getAttribute("title")).toBe(reason)
		}
	})

	it("offers no extract next to an archive below a directory shared with the user", () => {
		const shared = narrowItem({
			uuid: TEST_ARCHIVE,
			stableUUID: undefined,
			parent: testUuid("shared-parent"),
			size: 100n,
			favorited: false,
			region: "de-1",
			bucket: "filen-1",
			timestamp: 0n,
			chunks: 1n,
			canMakeThumbnail: false,
			meta: {
				type: "decoded",
				data: { name: "photos.zip", mime: "application/zip", modified: 0n, size: 100n, key: "k", version: 2 }
			},
			sharingRole: { type: "receiver", email: "a@example.com", id: 1 }
		})

		mockListViewport()
		show(fakeSession(done(), storeOf(TREE)), true, archiveSourceOf(shared, "sharedIn", testUuid("root")))

		// Extract all opens the places menu itself: there is no default next to the archive.
		expect(screen.queryByRole("button", { name: "More places to extract to" })).toBeNull()
		expect(screen.getByRole("button", { name: "Extract all" }).getAttribute("aria-haspopup")).toBe("menu")
	})

	it("disables the gate's Browse while offline", () => {
		onlineManager.setOnline(false)

		const fake = fakeSession({ type: "gate", format: { type: "tar", codec: "gzip" } })

		show(fake)

		const browse = screen.getByRole("button", { name: "Browse contents" })

		expect(browse.hasAttribute("disabled")).toBe(true)
		expect(browse.getAttribute("title")).toBe("Unavailable while offline")

		fireEvent.click(browse)

		expect(fake.session.start).not.toHaveBeenCalled()
	})

	it("keeps the gate's Browse but not its extract when the link allows no downloads", () => {
		show(fakeSession({ type: "gate", format: { type: "tar", codec: "gzip" } }), false)

		expect(screen.getByRole("button", { name: "Browse contents" }).hasAttribute("disabled")).toBe(false)
		expect(screen.getByRole("button", { name: "Extract all" }).hasAttribute("disabled")).toBe(true)
	})
})

describe("ArchiveSourceBrowser keys and navigation", () => {
	beforeEach(() => {
		mockListViewport()
		parentKeyDown.mockClear()
	})

	it("lists directories first and focuses the list", () => {
		show(fakeSession(done(), storeOf(TREE)))

		expect(options().map(option => option.textContent)).toEqual([
			expect.stringContaining("docs"),
			expect.stringContaining("readme.md"),
			expect.stringContaining("z.bin")
		])
		expect(document.activeElement).toBe(list())
	})

	it("moves the cursor on its own keys, leaving Left and Right to the overlay", () => {
		show(fakeSession(done(), storeOf(TREE)))

		expect(cursorName()).toContain("docs")
		expect(press("ArrowDown")).toBe(false)
		expect(cursorName()).toContain("readme.md")
		expect(press("End")).toBe(false)
		expect(cursorName()).toContain("z.bin")
		expect(parentKeyDown).not.toHaveBeenCalled()

		expect(press("ArrowLeft")).toBe(true)
		expect(press("ArrowRight")).toBe(true)
		expect(parentKeyDown).toHaveBeenCalledTimes(2)
	})

	it("toggles with Space, ranges with Shift, and keeps Escape while something is selected", () => {
		show(fakeSession(done(), storeOf(TREE)))

		press("ArrowDown")
		press(" ")

		expect(selectedNames()).toEqual([expect.stringContaining("readme.md")])

		press("ArrowDown", { shiftKey: true })

		expect(selectedNames()).toEqual([expect.stringContaining("readme.md"), expect.stringContaining("z.bin")])
		expect(screen.getByText("2 files selected · 2 B")).toBeTruthy()

		expect(press("Escape")).toBe(false)
		expect(selectedNames()).toEqual([])
		expect(parentKeyDown).not.toHaveBeenCalled()

		// Nothing selected: the overlay closes on it.
		expect(press("Escape")).toBe(true)
		expect(parentKeyDown).toHaveBeenCalledTimes(1)
	})

	it("selects everything with Mod+A, the directory then counting as one", () => {
		show(fakeSession(done(), storeOf(TREE)))

		press("a", { ctrlKey: true })

		expect(selectedNames()).toHaveLength(3)
		expect(screen.getByText("5 files selected · 5 B")).toBeTruthy()
		expect(screen.getByRole("checkbox", { name: "Select all" }).getAttribute("aria-checked")).toBe("true")
	})

	it("opens a directory on Enter, clearing the selection, and comes back up on Backspace", () => {
		const fake = fakeSession(done(), storeOf(TREE))

		show(fake)
		press("a", { ctrlKey: true })
		press("Enter")

		expect(fake.session.rememberDirPath).toHaveBeenLastCalledWith("docs")
		expect(options().map(option => option.textContent)).toEqual([
			expect.stringContaining("deep"),
			expect.stringContaining("a.txt"),
			expect.stringContaining("b.txt")
		])
		expect(selectedNames()).toEqual([])
		expect(screen.getByRole("button", { name: "docs" }).getAttribute("aria-current")).toBe("location")

		press("ArrowDown")
		press("Backspace")

		expect(fake.session.rememberDirPath).toHaveBeenLastCalledWith("")
		expect(cursorName()).toContain("docs")
	})

	it("starts over at the root when a new run lists into a fresh store", () => {
		const fake = fakeSession(done(), storeOf(TREE))

		show(fake)
		press("Enter")
		press("ArrowDown")

		expect(screen.getByRole("button", { name: "docs" })).toBeTruthy()

		fake.set({ type: "starting" }, storeOf([]))
		fake.set(done(), storeOf(TREE))

		expect(screen.queryByRole("button", { name: "docs" })).toBeNull()
		expect(options().map(option => option.textContent)).toEqual([
			expect.stringContaining("docs"),
			expect.stringContaining("readme.md"),
			expect.stringContaining("z.bin")
		])

		press("a", { ctrlKey: true })

		expect(screen.getByText("5 files selected · 5 B")).toBeTruthy()
	})

	it("reopens a cached listing where it was left", () => {
		const cache = createListingCache()
		const store = storeOf(TREE)

		cache.put(TEST_ARCHIVE, { store, summary: SUMMARY, password: undefined, lastDirPath: "docs", entries: store.entryCount })
		openListingSession.mockReturnValue(fakeSession(done(), store).session)
		render(
			<QueryClientProvider client={queryClient}>
				<ListingCacheContext value={cache}>
					<ArchiveSourceBrowser source={SOURCE} />
				</ListingCacheContext>
			</QueryClientProvider>
		)

		expect(screen.getByRole("button", { name: "docs" }).getAttribute("aria-current")).toBe("location")
		expect(openListingSession).toHaveBeenLastCalledWith(SOURCE, undefined, cache)
	})

	it("selects with clicks like the drive listing", () => {
		show(fakeSession(done(), storeOf(TREE)))

		const [docs, readme, zbin] = options()

		if (docs === undefined || readme === undefined || zbin === undefined) {
			throw new Error("rows missing")
		}

		fireEvent.click(readme, { detail: 1 })

		expect(selectedNames()).toEqual([expect.stringContaining("readme.md")])

		fireEvent.click(zbin, { detail: 1, ctrlKey: true })

		expect(selectedNames()).toHaveLength(2)

		fireEvent.click(docs, { detail: 1, shiftKey: true })

		expect(selectedNames()).toHaveLength(3)

		fireEvent.click(zbin, { detail: 1 })

		expect(selectedNames()).toEqual([expect.stringContaining("z.bin")])

		fireEvent.click(zbin, { detail: 1 })

		expect(selectedNames()).toEqual([])
	})

	it("selects and clears every search match with the header checkbox, keeping the rest of the selection", async () => {
		show(fakeSession(done(), storeOf(TREE)))

		fireEvent.click(screen.getByText("z.bin"), { detail: 1 })
		fireEvent.change(screen.getByRole("searchbox", { name: "Search this directory" }), { target: { value: ".txt" } })
		await wait(200)

		const header = screen.getByRole("checkbox", { name: "Select all" })

		expect(options()).toHaveLength(3)
		expect(header.getAttribute("aria-checked")).toBe("false")

		fireEvent.click(header)

		expect(header.getAttribute("aria-checked")).toBe("true")
		expect(screen.getByText("4 files selected · 4 B")).toBeTruthy()

		fireEvent.click(header)

		expect(header.getAttribute("aria-checked")).toBe("false")
		expect(screen.getByText("1 file selected · 1 B")).toBeTruthy()

		press("a", { ctrlKey: true })

		expect(screen.getByText("4 files selected · 4 B")).toBeTruthy()
	})

	it("counts a match its directory's selection takes in, and clears it from the header", async () => {
		show(fakeSession(done(), storeOf(TREE)))

		fireEvent.click(screen.getByText("docs"), { detail: 1 })
		fireEvent.change(screen.getByRole("searchbox", { name: "Search this directory" }), { target: { value: ".txt" } })
		await wait(200)

		const header = screen.getByRole("checkbox", { name: "Select all" })

		expect(header.getAttribute("aria-checked")).toBe("true")

		fireEvent.click(header)

		expect(header.getAttribute("aria-checked")).toBe("false")
	})

	it("searches below the directory shown, showing where each match is", async () => {
		show(fakeSession(done(), storeOf(TREE)))

		fireEvent.change(screen.getByRole("searchbox", { name: "Search this directory" }), { target: { value: "c.txt" } })
		await wait(200)

		expect(options().map(option => option.textContent)).toEqual([expect.stringContaining("docs/deep")])

		fireEvent.change(screen.getByRole("searchbox", { name: "Search this directory" }), { target: { value: "nothing" } })
		await wait(200)

		expect(screen.getByText("Nothing here matches “nothing”.")).toBeTruthy()
	})
})
