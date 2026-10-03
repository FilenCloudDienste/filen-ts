// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClientProvider } from "@tanstack/react-query"
import type { File, UuidStr } from "@filen/sdk-rs"
import type { ListReportDTO } from "@/lib/sdk/jobErrors"
import type { ListJobEvent, ListJobParams } from "@/workers/sdk.worker"
import type { DriveItem } from "@/features/drive/lib/item"
import type { ListingCache } from "@/features/archive/lib/listingCache"
import { packEntries } from "@/tests/support/archiveEntries"

// The real overlay, browser and listing session over a scripted worker: a listing the overlay cached
// (its entry names, its password) is gone once the overlay closes or the user signs out, even though the
// browser inside is disposed after the overlay's own cleanup ran and would cache it again.

interface ListCall {
	id: string
	params: ListJobParams
	password: string | undefined
	emit: (event: ListJobEvent) => void
	resolve: (report: ListReportDTO) => void
}

const { calls, caches } = vi.hoisted(() => ({ calls: [] as ListCall[], caches: [] as ListingCache[] }))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: {
		listArchive: (id: string, params: ListJobParams, password: string | undefined, onEvent: (event: ListJobEvent) => void) =>
			new Promise<ListReportDTO>(resolve => {
				calls.push({ id, params, password, emit: onEvent, resolve })
			}),
		cancelTransfer: () => Promise.resolve(),
		releaseJob: () => Promise.resolve(),
		archiveNameInfo: (names: string[]) => Promise.resolve(names.map(() => ({ format: { type: "zip" }, defaultName: "photos" })))
	}
}))
vi.mock("@/queries/client", async () => {
	const { QueryClient: Client } = await import("@tanstack/react-query")
	return { queryClient: new Client({ defaultOptions: { queries: { retry: false } } }) }
})
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), custom: vi.fn(), dismiss: vi.fn() } }))
vi.mock("@tanstack/react-router", () => ({
	useBlocker: () => ({ status: "idle" }),
	useNavigate: () => vi.fn(),
	useRouterState: () => "/drive"
}))
vi.mock("@/lib/keymap/useAction", () => ({ useAction: vi.fn(), IN_EDITORS: {}, IN_EDITORS_AND_FIELDS: {} }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@/features/drive/lib/actions", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/actions")>()),
	currentRootUuid: () => "root-0000-0000-0000-000000000000"
}))
// Every cache the overlay makes, to look into after it closed.
vi.mock("@/features/archive/lib/listingCache", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/archive/lib/listingCache")>()

	return {
		...actual,
		createListingCache: () => {
			const cache = actual.createListingCache()

			caches.push(cache)

			return cache
		}
	}
})

import "@/lib/i18n"
import { queryClient } from "@/queries/client"
import { narrowItem } from "@/features/drive/lib/item"
import { clearArchiveListings } from "@/features/archive/lib/listingCache"
import { usePreviewUnsavedGuardStore } from "@/features/preview/store/usePreviewUnsavedGuard"
import { PreviewOverlay } from "@/features/preview/components/previewOverlay"

const ZIP = "zip00000-0000-0000-0000-000000000000"
const OTHER = "zip11111-0000-0000-0000-000000000000"

function zip(uuid: string, name: string): DriveItem {
	return narrowItem({
		uuid: uuid as UuidStr,
		stableUUID: uuid as File["stableUUID"],
		parent: "parent-0000-0000-0000-000000000000" as UuidStr,
		size: 1024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "application/zip", modified: 0n, size: 1024n, key: "k", version: 2 } }
	})
}

const ITEMS = [zip(ZIP, "photos.zip"), zip(OTHER, "other.zip")]

function overlay(index: number) {
	return (
		<QueryClientProvider client={queryClient}>
			<PreviewOverlay
				variant="drive"
				items={ITEMS}
				index={index}
				onStep={vi.fn()}
				onClose={vi.fn()}
				onItemRemoved={vi.fn()}
			/>
		</QueryClientProvider>
	)
}

function report(extra: Partial<ListReportDTO> = {}): ListReportDTO {
	return {
		format: { type: "zip" },
		password: "notNeeded",
		entries: [],
		omittedEntries: 0n,
		undeliveredEntries: 0n,
		totals: { entries: 1n, dirs: 1n, files: 1n, bytes: 1n, skipped: 0n, bytesSkipped: 0n },
		unaccountedBytes: 0n,
		duplicates: undefined,
		error: undefined,
		...extra
	}
}

function lastCall(): ListCall {
	const call = calls.at(-1)

	if (call === undefined) {
		throw new Error("no listing call")
	}

	return call
}

function onlyCache(): ListingCache {
	expect(caches).toHaveLength(1)

	const [cache] = caches

	if (cache === undefined) {
		throw new Error("no cache")
	}

	return cache
}

// Lists photos.zip in full: an encrypted entry, then the password checked and accepted.
async function listWithPassword(): Promise<void> {
	await waitFor(() => {
		expect(calls).toHaveLength(1)
	})

	const [batch] = packEntries(["secret/plans.txt"])

	if (batch === undefined) {
		throw new Error("no batch")
	}

	await act(async () => {
		lastCall().emit({ type: "entries", batch })
		lastCall().resolve(report({ password: "required" }))
		await Promise.resolve()
	})

	fireEvent.click(screen.getByRole("button", { name: "Enter password" }))

	const input = await screen.findByLabelText("Password")

	fireEvent.change(input, { target: { value: "hunter2" } })
	fireEvent.click(screen.getByRole("button", { name: "Unlock" }))
	await waitFor(() => {
		expect(calls).toHaveLength(2)
	})

	expect(lastCall().password).toBe("hunter2")

	await act(async () => {
		lastCall().resolve(report({ password: "right" }))
		await Promise.resolve()
	})
	await waitFor(() => {
		expect(screen.queryByText("Checking the password…")).toBeNull()
	})
}

afterEach(() => {
	cleanup()
	calls.length = 0
	caches.length = 0
	usePreviewUnsavedGuardStore.setState({ dirty: false, logoutRequest: null })
})

describe("the overlay's archive listings", () => {
	it("keep a listing, with its password, while the overlay stays open", async () => {
		const { rerender } = render(overlay(0))

		await listWithPassword()

		// A step to the next archive disposes the browser: the listing is cached.
		rerender(overlay(1))

		const cached = onlyCache().get(ZIP)

		expect(cached?.password).toBe("hunter2")
		expect(cached?.store.entryCount).toBe(1)
	})

	it("are gone once the overlay closes, though the browser is disposed after its cleanup", async () => {
		const { unmount } = render(overlay(0))

		await listWithPassword()

		const cache = onlyCache()

		unmount()

		expect(cache.get(ZIP)).toBeUndefined()
	})

	it("are gone at sign-out, and stay gone when the browser is disposed after it", async () => {
		const { rerender, unmount } = render(overlay(0))

		await listWithPassword()

		const cache = onlyCache()

		clearArchiveListings()
		rerender(overlay(1))

		expect(cache.get(ZIP)).toBeUndefined()

		unmount()

		expect(cache.get(ZIP)).toBeUndefined()
		expect(cache.get(OTHER)).toBeUndefined()
	})
})
