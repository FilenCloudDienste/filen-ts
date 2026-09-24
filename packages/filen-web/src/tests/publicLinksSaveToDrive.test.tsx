// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { CopyItem, File as SdkFile, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"

const { hasClient, ownsItem, startLinkedCopyWithCard, dialogProps } = vi.hoisted(() => ({
	hasClient: vi.fn<() => Promise<boolean>>(),
	ownsItem: vi.fn<(kind: "file" | "directory", uuid: string) => Promise<boolean>>(),
	startLinkedCopyWithCard: vi.fn(),
	dialogProps: { current: null as null | { onCopy?: (destination: { uuid: string | null; name: string }) => void; onClose: () => void } }
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { hasClient, ownsItem } }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }) }))
vi.mock("@/features/transfers/lib/copyToast", () => ({ startLinkedCopyWithCard }))
// The picker itself is drive's, tested on its own; here it only has to receive the save's own copy.
vi.mock("@/features/drive/components/moveTargetDialog", () => ({
	MoveTargetDialog: (props: NonNullable<(typeof dialogProps)["current"]>) => {
		dialogProps.current = props

		return null
	}
}))

import { queryClient } from "@/queries/client"
import { driveListingQueryKey } from "@/features/drive/queries/drive"
import { narrowItem } from "@/features/drive/lib/item"
import { useLinkSaveable } from "@/features/publicLinks/queries/publicLink"
import { SaveToDriveButton } from "@/features/publicLinks/components/saveToDrive"

const FILE_UUID = "f1000000-0000-0000-0000-000000000000" as UuidStr

const OWNED_FILE: SdkFile = {
	uuid: FILE_UUID,
	stableUUID: undefined,
	parent: "p1000000-0000-0000-0000-000000000000",
	size: 1n,
	favorited: false,
	region: "de-1",
	bucket: "filen-1",
	timestamp: 0n,
	chunks: 1n,
	canMakeThumbnail: false,
	meta: { type: "decoded", data: { name: "a.txt", mime: "text/plain", modified: 0n, size: 1n, key: "k", version: 2 } }
}

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: queryClient, children })
}

async function settle(): Promise<void> {
	await act(async () => {
		for (let i = 0; i < 10; i++) {
			await new Promise(resolve => setTimeout(resolve, 0))
		}
	})
}

beforeEach(() => {
	queryClient.clear()
	dialogProps.current = null
})

afterEach(() => {
	cleanup()
})

describe("useLinkSaveable", () => {
	it("is off for a signed-out visitor, without an owner lookup", async () => {
		hasClient.mockResolvedValue(false)
		const { result } = renderHook(() => useLinkSaveable("file", FILE_UUID), { wrapper })

		await settle()

		expect(result.current).toBe(false)
		expect(ownsItem).not.toHaveBeenCalled()
	})

	it("is on for a signed-in visitor who doesn't own the link", async () => {
		hasClient.mockResolvedValue(true)
		ownsItem.mockResolvedValue(false)
		const { result } = renderHook(() => useLinkSaveable("directory", FILE_UUID), { wrapper })

		await settle()

		expect(result.current).toBe(true)
		expect(ownsItem).toHaveBeenCalledExactlyOnceWith("directory", FILE_UUID)
	})

	it("is off for the owner", async () => {
		hasClient.mockResolvedValue(true)
		ownsItem.mockResolvedValue(true)
		const { result } = renderHook(() => useLinkSaveable("file", FILE_UUID), { wrapper })

		await settle()

		expect(result.current).toBe(false)
	})

	it("reads ownership off an owned listing already cached, with no request", async () => {
		hasClient.mockResolvedValue(true)
		queryClient.setQueryData(driveListingQueryKey({ variant: "links", uuid: null }), [narrowItem(OWNED_FILE)])
		const { result } = renderHook(() => useLinkSaveable("file", FILE_UUID), { wrapper })

		await settle()

		expect(result.current).toBe(false)
		expect(ownsItem).not.toHaveBeenCalled()
	})

	it("doesn't count an item shared with the visitor as theirs", async () => {
		hasClient.mockResolvedValue(true)
		ownsItem.mockResolvedValue(false)
		queryClient.setQueryData(driveListingQueryKey({ variant: "sharedIn", uuid: null }), [narrowItem(OWNED_FILE)])
		const { result } = renderHook(() => useLinkSaveable("file", FILE_UUID), { wrapper })

		await settle()

		expect(result.current).toBe(true)
	})
})

describe("SaveToDriveButton", () => {
	it("copies the linked item into the directory the picker returns", () => {
		const item = { uuid: FILE_UUID, fileKey: "k" } as unknown as CopyItem

		render(createElement(SaveToDriveButton, { item, name: "a.txt", glyph: "file" }))
		fireEvent.click(screen.getByRole("button", { name: "Save to Cloud Drive" }))

		const destination = { uuid: "d1000000-0000-0000-0000-000000000000", name: "Docs" }

		dialogProps.current?.onCopy?.(destination)

		expect(startLinkedCopyWithCard).toHaveBeenCalledExactlyOnceWith(item, "a.txt", "file", destination)
	})
})
