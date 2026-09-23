// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from "@tanstack/react-query"
import type {
	AnyLinkedDir,
	DirPublicInfo,
	DirPublicLink,
	DirSizeResponse,
	File as SdkFile,
	LinkedDir,
	LinkedDirsAndFiles
} from "@filen/sdk-rs"
import "@/lib/i18n"

const { getLinkedFileAnon, getDirPublicLinkInfoAnon, getLinkedDirSizeAnon, listLinkedDirAnon } = vi.hoisted(() => ({
	getLinkedFileAnon: vi.fn<(uuid: string, key: string, password: string | undefined) => Promise<unknown>>(),
	getDirPublicLinkInfoAnon: vi.fn<(uuid: string, key: string) => Promise<DirPublicInfo>>(),
	getLinkedDirSizeAnon: vi.fn<(args: { dir: AnyLinkedDir; link: DirPublicLink }) => Promise<DirSizeResponse>>(),
	listLinkedDirAnon: vi.fn<(dir: AnyLinkedDir, link: DirPublicLink) => Promise<LinkedDirsAndFiles>>()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { getLinkedFileAnon, getDirPublicLinkInfoAnon, getLinkedDirSizeAnon, listLinkedDirAnon }
}))

// The production defaults minus the persister (sqlite, unavailable under vitest).
vi.mock("@/queries/client", () => ({
	queryClient: new QueryClient({
		defaultOptions: {
			queries: { staleTime: 0, gcTime: Infinity, retry: false, refetchOnWindowFocus: true, refetchOnReconnect: true }
		}
	})
}))

vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children: ReactNode }) => createElement("a", null, children)
}))

import { queryClient } from "@/queries/client"
import { usePublicFile, publicDirListingQueryKey } from "@/features/publicLinks/queries/publicLink"
import { linkForBrowsing } from "@/features/publicLinks/lib/password.logic"
import { DirectoryLinkView } from "@/features/publicLinks/components/directoryLinkView"

type Uuid = `${string}-${string}-${string}-${string}-${string}`

const PARENT: Uuid = "00000000-0000-0000-0000-000000000000"
const SUB_UUID: Uuid = "d0000000-0000-0000-0000-00000000000a"
const SIZE: DirSizeResponse = { size: 1_024n, files: 1n, dirs: 1n }
const WIRE_ERROR = { species: "sdk", kind: "Reqwest", label: "network error", message: "network error" }
const PASSWORD_ERROR = { species: "sdk", kind: "WrongPassword", label: "Wrong password", message: "wrong password" }

function makeFile(uuid: Uuid, name: string): SdkFile {
	return {
		uuid,
		stableUUID: undefined,
		meta: { type: "decoded", data: { name, mime: "text/plain", size: 10n, key: "k", version: 2, modified: 1n } },
		parent: PARENT,
		size: 10n,
		favorited: false,
		region: "",
		bucket: "",
		timestamp: 1n,
		chunks: 1n,
		canMakeThumbnail: false
	}
}

const subDir: LinkedDir = {
	inner: {
		uuid: SUB_UUID,
		parent: PARENT,
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name: "Sub" } }
	},
	linkedTag: true
}

const ROOT_LISTING: LinkedDirsAndFiles = { dirs: [subDir], files: [makeFile("f0000000-0000-0000-0000-00000000000a", "root.txt")] }
const SUB_LISTING: LinkedDirsAndFiles = { dirs: [], files: [makeFile("f0000000-0000-0000-0000-00000000000b", "inner.txt")] }

// Every test uses its own link: the query cache outlives a test.
let linkCounter = 0

function nextInfo(hasPassword: boolean): DirPublicInfo {
	linkCounter++

	const suffix = String(linkCounter).padStart(12, "0")

	return {
		root: {
			inner: {
				uuid: `e0000000-0000-0000-0000-${suffix}`,
				color: "default",
				timestamp: 0n,
				meta: { type: "decoded", data: { name: "Shared" } }
			},
			linkedTag: true
		},
		link: {
			linkUuid: `c0000000-0000-0000-0000-${suffix}`,
			linkKey: `key-${suffix}`,
			linkKeyVersion: 2,
			password: hasPassword ? { type: "hashed", data: "server-hash" } : { type: "none" },
			enableDownload: false,
			salt: "salt"
		},
		hasPassword
	}
}

function listingFor(dir: AnyLinkedDir): LinkedDirsAndFiles {
	return (dir as LinkedDir).inner.uuid === SUB_UUID ? SUB_LISTING : ROOT_LISTING
}

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: queryClient, children })
}

async function drain(): Promise<void> {
	await act(async () => {
		for (let i = 0; i < 20; i++) {
			await new Promise(resolve => setTimeout(resolve, 0))
		}
	})
	await waitFor(() => {
		expect(queryClient.isFetching()).toBe(0)
	})
}

async function focusAndReconnect(): Promise<void> {
	act(() => {
		focusManager.setFocused(false)
		focusManager.setFocused(true)
		onlineManager.setOnline(false)
		onlineManager.setOnline(true)
	})
	await drain()
}

async function openDirectoryLink(info: DirPublicInfo): Promise<void> {
	getDirPublicLinkInfoAnon.mockResolvedValue(info)
	render(createElement(DirectoryLinkView, { uuid: info.root.inner.uuid, linkKey: info.link.linkKey }), { wrapper })
	await drain()
}

async function submitPassword(password: string): Promise<void> {
	fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } })
	fireEvent.click(screen.getByRole("button", { name: "Unlock" }))
	await drain()
}

beforeEach(() => {
	vi.clearAllMocks()
	listLinkedDirAnon.mockImplementation(dir => Promise.resolve(listingFor(dir)))
	getLinkedDirSizeAnon.mockResolvedValue(SIZE)
})

afterEach(() => {
	cleanup()
	focusManager.setFocused(undefined)
	onlineManager.setOnline(true)
})

describe("public directory link request count", () => {
	it("serves the resolved snapshot on focus and reconnect: 0 extra dirInfo, listing or size reads", async () => {
		await openDirectoryLink(nextInfo(false))
		expect(screen.getByText("root.txt")).toBeTruthy()
		expect(getDirPublicLinkInfoAnon).toHaveBeenCalledTimes(1)
		expect(listLinkedDirAnon).toHaveBeenCalledTimes(1)
		expect(getLinkedDirSizeAnon).toHaveBeenCalledTimes(1)

		await focusAndReconnect()

		expect(getDirPublicLinkInfoAnon).toHaveBeenCalledTimes(1)
		expect(listLinkedDirAnon).toHaveBeenCalledTimes(1)
		expect(getLinkedDirSizeAnon).toHaveBeenCalledTimes(1)
	})

	it("serves a visited level on a breadcrumb jump back: 0 extra listing or size reads", async () => {
		await openDirectoryLink(nextInfo(false))

		fireEvent.click(screen.getByText("Sub"))
		await drain()
		expect(screen.getByText("inner.txt")).toBeTruthy()
		expect(listLinkedDirAnon).toHaveBeenCalledTimes(2)
		expect(getLinkedDirSizeAnon).toHaveBeenCalledTimes(2)

		fireEvent.click(screen.getByRole("button", { name: "Shared" }))
		await drain()

		expect(screen.getByText("root.txt")).toBeTruthy()
		expect(listLinkedDirAnon).toHaveBeenCalledTimes(2)
		expect(getLinkedDirSizeAnon).toHaveBeenCalledTimes(2)
	})

	it("re-reads a level that failed on the wire once the connection returns, never on focus", async () => {
		listLinkedDirAnon.mockRejectedValueOnce(WIRE_ERROR)
		await openDirectoryLink(nextInfo(false))
		expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy()
		expect(listLinkedDirAnon).toHaveBeenCalledTimes(1)

		act(() => {
			focusManager.setFocused(false)
			focusManager.setFocused(true)
		})
		await drain()
		expect(listLinkedDirAnon).toHaveBeenCalledTimes(1)

		act(() => {
			onlineManager.setOnline(false)
			onlineManager.setOnline(true)
		})
		await drain()

		expect(listLinkedDirAnon).toHaveBeenCalledTimes(2)
		expect(screen.getByText("root.txt")).toBeTruthy()
		// Only the failed read re-ran; the resolved ones stayed put.
		expect(getDirPublicLinkInfoAnon).toHaveBeenCalledTimes(1)
		expect(getLinkedDirSizeAnon).toHaveBeenCalledTimes(1)
	})

	it("opens the browser on the listing the password check read: 1 listing read in total", async () => {
		const info = nextInfo(true)
		await openDirectoryLink(info)
		expect(listLinkedDirAnon).not.toHaveBeenCalled()

		await submitPassword("right")

		expect(screen.getByText("root.txt")).toBeTruthy()
		expect(listLinkedDirAnon).toHaveBeenCalledTimes(1)
		expect(listLinkedDirAnon).toHaveBeenCalledWith(info.root, linkForBrowsing(info, "right"))
		expect(queryClient.getQueryData(publicDirListingQueryKey(info.root.inner.uuid, linkForBrowsing(info, "right")))).toBe(ROOT_LISTING)
	})

	it("reads once per attempt after a wrong password and caches nothing under the wrong one", async () => {
		const info = nextInfo(true)
		await openDirectoryLink(info)

		listLinkedDirAnon.mockRejectedValueOnce(PASSWORD_ERROR)
		await submitPassword("wrong")
		expect(screen.getByText("Wrong password. Please try again.")).toBeTruthy()
		expect(listLinkedDirAnon).toHaveBeenCalledTimes(1)

		await submitPassword("right")

		expect(screen.getByText("root.txt")).toBeTruthy()
		expect(listLinkedDirAnon).toHaveBeenCalledTimes(2)
		expect(queryClient.getQueryData(publicDirListingQueryKey(info.root.inner.uuid, linkForBrowsing(info, "wrong")))).toBeUndefined()
	})
})

describe("public file link request count", () => {
	it("serves the resolved file on focus and reconnect: 0 extra reads", async () => {
		getLinkedFileAnon.mockResolvedValue({ uuid: "file" })
		renderHook(() => usePublicFile("f1000000-0000-0000-0000-000000000001", "file-key", undefined), { wrapper })
		await drain()
		expect(getLinkedFileAnon).toHaveBeenCalledTimes(1)

		await focusAndReconnect()

		expect(getLinkedFileAnon).toHaveBeenCalledTimes(1)
	})
})
