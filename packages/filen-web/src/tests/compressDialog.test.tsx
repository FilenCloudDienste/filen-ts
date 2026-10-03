// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import type { CompressJobRequest } from "@/features/drive/lib/archiveJobs.logic"
import type { ArchiveFormat, CompressFormat, Dir, File, StreamCodec, UserInfo } from "@filen/sdk-rs"
import { i18n } from "@/lib/i18n"

const {
	archiveFormatInfo,
	archiveNameInfo,
	itemNameErrors,
	archiveCodecMemBudget,
	startCompressWithCard,
	setCompressPreferences,
	online,
	rememberedFormat
} = vi.hoisted(() => ({
	archiveFormatInfo: vi.fn(),
	archiveNameInfo: vi.fn(),
	// The SDK's own name rules, as far as these tests go.
	itemNameErrors: vi.fn((names: string[]) => Promise.resolve(names.map(name => (name.includes(":") ? "ForbiddenChar" : null)))),
	archiveCodecMemBudget: vi.fn(() => Promise.resolve(128 * 1024 * 1024)),
	startCompressWithCard: vi.fn((_request: Omit<CompressJobRequest, "id">, _password: string | undefined) => "job"),
	setCompressPreferences: vi.fn(() => Promise.resolve()),
	online: { current: true },
	rememberedFormat: { current: "zip" }
}))

vi.mock("@/queries/client", async () => {
	const { QueryClient: Client } = await import("@tanstack/react-query")

	return { queryClient: new Client() }
})
vi.mock("@/lib/sdk/client", () => ({ sdkApi: { archiveFormatInfo, archiveNameInfo, itemNameErrors, archiveCodecMemBudget } }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => online.current }))
vi.mock("@/features/transfers/lib/archiveToast", () => ({ startCompressWithCard }))
vi.mock("@/features/drive/lib/compressPreferences", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/compressPreferences")>()),
	loadCompressPreferences: () => Promise.resolve({ ...DEFAULT_PREFS, format: rememberedFormat.current }),
	setCompressPreferences
}))
vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, to }: { children: ReactNode; to: string }) => createElement("a", { href: to }, children)
}))

import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { DEFAULT_COMPRESS_PREFERENCES } from "@/features/drive/lib/compressPreferences"
import { CATALOGUE } from "@/features/drive/components/compressDialog.logic"
import { CompressDialog } from "@/features/drive/components/compressDialog"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"
import { testUuid } from "@/tests/support/uuid"

const DEFAULT_PREFS = { ...DEFAULT_COMPRESS_PREFERENCES, zip: { method: "deflate" as const, level: 9, aes: "aes256" as const } }
const ROOT = testUuid("root")
const PARENT = testUuid("parent")
const CODEC_EXTENSIONS: Record<StreamCodec, string> = {
	gzip: "gz",
	bzip2: "bz2",
	xz: "xz",
	lzma: "lzma",
	lzip: "lz",
	lz4: "lz4",
	brotli: "br",
	zstd: "zst"
}

function fakeInfo(format: CompressFormat) {
	const extension =
		format.type === "zip"
			? ".zip"
			: format.type === "sevenZ"
				? ".7z"
				: format.type === "single"
					? `.${CODEC_EXTENSIONS[format.compression.codec]}`
					: format.compression === undefined
						? ".tar"
						: `.tar.${CODEC_EXTENSIONS[format.compression.codec]}`
	const level =
		format.type === "zip" || format.type === "sevenZ"
			? "level" in format.method
				? format.method.level
				: null
			: format.type === "tar" && format.compression === undefined
				? null
				: (format.compression?.level ?? 6)
	const leveled = level !== null

	return {
		extension,
		levels: leveled ? { min: 1, max: 9, defaultLevel: 6 } : null,
		maxLevel: leveled ? 5 : null,
		encoderMemory: leveled ? level * 1024 * 1024 : null
	}
}

function file(name: string): DriveItem {
	const raw: File = {
		uuid: testUuid(name),
		stableUUID: undefined,
		parent: PARENT,
		size: 100n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "application/pdf", modified: 0n, size: 100n, key: "k", version: 2 } }
	}

	return narrowItem(raw)
}

function dir(name: string): DriveItem {
	const raw: Dir = {
		uuid: testUuid(name),
		parent: PARENT,
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name } }
	}

	return narrowItem(raw)
}

const onClose = vi.fn()

async function renderDialog(items: DriveItem[], variant: DriveVariant = "drive"): Promise<void> {
	render(createElement(CompressDialog, { items, variant, onClose }), { wrapper: queryClientWrapper(createTestQueryClient()) })

	await screen.findByLabelText("Name")
}

function submitButton(): HTMLButtonElement {
	return screen.getByRole("button", { name: "Compress" })
}

// A submit asks the SDK about the exact name first (at once once answered), then starts.
async function submitAndSettle(): Promise<void> {
	await act(async () => {
		fireEvent.click(submitButton())
		await new Promise(resolve => setTimeout(resolve, 0))
	})
}

// The one compress the dialog started.
function started(): [Omit<CompressJobRequest, "id">, string | undefined] {
	const call = startCompressWithCard.mock.calls[0]

	if (call === undefined) {
		throw new Error("no compress was started")
	}

	return call
}

function type(label: string, value: string): void {
	fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

// What the SDK reads a name as, for the names these tests compose: a tarball wins over a lone `.gz`.
function fakeNameInfo(name: string): { format: ArchiveFormat | null; defaultName: string } {
	return {
		format: name.endsWith(".tar.gz") ? { type: "tar", codec: "gzip" } : name.endsWith(".gz") ? { type: "single", codec: "gzip" } : null,
		defaultName: name
	}
}

beforeEach(() => {
	archiveFormatInfo.mockImplementation((formats: CompressFormat[]) => Promise.resolve(formats.map(fakeInfo)))
	archiveNameInfo.mockImplementation((names: string[]) => Promise.resolve(names.map(fakeNameInfo)))
	rememberedFormat.current = "zip"
	online.current = true
	queryClient.setQueryData<Partial<UserInfo>>(ACCOUNT_QUERY_KEY, { rootDirUuid: ROOT })
})

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
	useDriveStore.getState().clearSelectedItems()
})

describe("CompressDialog", () => {
	// First in the file: the helper keeps format answers for the page, so later mounts ask nothing.
	it("asks about every format in one worker call, then the slider's memory in one more, and nothing again", async () => {
		await renderDialog([file("report.pdf")])
		await screen.findByText(/^Level 5 ·/)

		expect(archiveFormatInfo).toHaveBeenCalledTimes(2)
		expect(archiveFormatInfo.mock.calls[0]?.[0]).toHaveLength(CATALOGUE.length)
		// Level 1 is the catalogue's own probe, already answered.
		expect(archiveFormatInfo.mock.calls[1]?.[0]).toEqual(
			[2, 3, 4, 5].map(level => ({ type: "zip", method: { type: "deflate", level } }))
		)
		expect(archiveCodecMemBudget).toHaveBeenCalledTimes(1)

		cleanup()
		await renderDialog([file("report.pdf")])
		await screen.findByText(/^Level 5 ·/)

		expect(archiveFormatInfo).toHaveBeenCalledTimes(2)
	})

	it("names the archive after the item, caps the remembered level and starts it", async () => {
		await renderDialog([file("report.pdf")])

		expect(screen.getByLabelText("Name")).toHaveProperty("value", "report")
		expect(screen.getByText(".zip")).toBeTruthy()

		await submitAndSettle()

		expect(startCompressWithCard).toHaveBeenCalledTimes(1)

		const [request, password] = started()

		expect(request).toMatchObject({
			source: { kind: "items", items: [{ type: "file" }] },
			destination: { uuid: PARENT },
			name: "report.zip",
			format: { type: "zip", method: { type: "deflate", level: 5 } },
			encrypted: false,
			dispose: null,
			itemCount: 1
		})
		expect(password).toBeUndefined()
		expect(setCompressPreferences).toHaveBeenCalledWith(
			expect.objectContaining({ format: "zip", zip: { method: "deflate", level: 5, aes: "aes256" } })
		)
		expect(onClose).toHaveBeenCalledTimes(1)
	})

	it("passes the password only with encryption and never stores it", async () => {
		await renderDialog([dir("Docs")])

		fireEvent.click(screen.getByRole("switch", { name: "Protect with a password" }))
		type("Password", "hunter2")
		type("Confirm password", "hunter3")

		expect(screen.getByText("The passwords don't match")).toBeTruthy()

		await submitAndSettle()

		expect(startCompressWithCard).not.toHaveBeenCalled()

		type("Confirm password", "hunter2")
		await submitAndSettle()

		expect(startCompressWithCard).toHaveBeenCalledTimes(1)
		expect(started()).toMatchObject([{ name: "Docs.zip", encrypted: true, format: { encryption: "aes256" } }, "hunter2"])
		expect(JSON.stringify(setCompressPreferences.mock.calls)).not.toContain("hunter2")
	})

	it("reveals both password fields together", async () => {
		await renderDialog([dir("Docs")])

		fireEvent.click(screen.getByRole("switch", { name: "Protect with a password" }))

		expect(screen.getByLabelText("Password").className).toContain("text-security")

		fireEvent.click(screen.getByRole("button", { name: "Show password" }))

		expect(screen.getByLabelText("Password").className).not.toContain("text-security")
		expect(screen.getByLabelText("Confirm password").className).not.toContain("text-security")
		expect(screen.getByRole("button", { name: "Hide password" }).getAttribute("aria-pressed")).toBe("true")
	})

	it("confirms a permanent deletion, then starts it and drops the originals from the selection", async () => {
		const item = dir("Docs")

		useDriveStore.getState().setSelectedItems([item])
		await renderDialog([item])

		fireEvent.click(screen.getByRole("radio", { name: "Delete the originals permanently" }))
		await submitAndSettle()

		const confirm = await screen.findByRole("alertdialog")

		expect(confirm.textContent).toContain("downloaded again and checked")
		expect(startCompressWithCard).not.toHaveBeenCalled()

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }))
			await new Promise(resolve => setTimeout(resolve, 0))
		})

		expect(startCompressWithCard).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ dispose: "deletePermanently" }), undefined)
		expect(useDriveStore.getState().selectedItems).toEqual([])
		expect(onClose).toHaveBeenCalledTimes(1)
	})

	it("keeps the selection when the originals stay", async () => {
		const item = dir("Docs")

		useDriveStore.getState().setSelectedItems([item])
		await renderDialog([item])
		await submitAndSettle()

		expect(startCompressWithCard).toHaveBeenCalledTimes(1)
		expect(useDriveStore.getState().selectedItems).toEqual([item])
	})

	it("offers no Afterwards for someone else's items", async () => {
		await renderDialog([dir("Docs")], "sharedIn")

		expect(screen.queryByText("Afterwards")).toBeNull()

		cleanup()
		await renderDialog([dir("Docs")], "drive")

		expect(screen.getByText("Afterwards")).toBeTruthy()
	})

	it("disables the submit offline", async () => {
		online.current = false
		await renderDialog([dir("Docs")])

		expect(submitButton().disabled).toBe(true)
		expect(submitButton().title).toBe("Unavailable while offline")

		const form = submitButton().closest("form")

		if (form === null) {
			throw new Error("the dialog has no form")
		}

		fireEvent.submit(form)

		expect(startCompressWithCard).not.toHaveBeenCalled()
	})

	it("compresses one file on its own under its whole name, the codec's extension on top", async () => {
		rememberedFormat.current = "gz"
		await renderDialog([file("dump.tar.gz")])

		expect(screen.getByLabelText("Name")).toHaveProperty("value", "dump.tar.gz")

		await waitFor(() => {
			expect(archiveNameInfo).toHaveBeenCalledExactlyOnceWith(["dump.tar.gz.gz"])
		})

		await submitAndSettle()

		expect(started()[0]).toMatchObject({ name: "dump.tar.gz.gz", format: { type: "single", compression: { codec: "gzip" } } })
	})

	it("refuses a single-file name the SDK reads as another format", async () => {
		rememberedFormat.current = "gz"
		await renderDialog([file("backup.tar")])

		expect(await screen.findByText(i18n.t("archive:archiveNameOtherFormat"))).toBeTruthy()
		expect(archiveNameInfo).toHaveBeenCalledExactlyOnceWith(["backup.tar.gz"])

		await submitAndSettle()

		expect(startCompressWithCard).not.toHaveBeenCalled()

		type("Name", "backup")

		await waitFor(() => {
			expect(screen.queryByText(i18n.t("archive:archiveNameOtherFormat"))).toBeNull()
		})

		await submitAndSettle()

		expect(started()[0]).toMatchObject({ name: "backup.gz" })
	})

	it("asks the SDK about a typed name once typing pauses, and says why it refuses one", async () => {
		await renderDialog([dir("Docs")])

		type("Name", "a")
		type("Name", "a:")
		type("Name", "a:b")

		expect(await screen.findByText(i18n.t("archive:archiveName_ForbiddenChar"))).toBeTruthy()
		// Only the name typing paused on.
		expect(itemNameErrors).toHaveBeenLastCalledWith(["a:b.zip"])
		expect(itemNameErrors).not.toHaveBeenCalledWith(["a.zip"])
		expect(itemNameErrors).not.toHaveBeenCalledWith(["a:.zip"])

		await submitAndSettle()

		expect(startCompressWithCard).not.toHaveBeenCalled()
	})

	it("checks the exact name on a submit right after typing", async () => {
		await renderDialog([dir("Docs")])

		type("Name", "x:y")
		await submitAndSettle()

		expect(startCompressWithCard).not.toHaveBeenCalled()
		expect(itemNameErrors).toHaveBeenCalledWith(["x:y.zip"])
	})

	it("refuses an empty name at once", async () => {
		await renderDialog([dir("Docs")])

		type("Name", " ")

		expect(screen.getByText(i18n.t("archive:archiveName_Empty"))).toBeTruthy()
	})

	it("keeps the submit enabled and says on submit why it can't start", async () => {
		await renderDialog([dir("Docs")])

		fireEvent.click(screen.getByRole("switch", { name: "Protect with a password" }))

		expect(screen.queryByText(i18n.t("archive:archivePasswordEmpty"))).toBeNull()
		expect(submitButton().disabled).toBe(false)

		await submitAndSettle()

		expect(screen.getByText(i18n.t("archive:archivePasswordEmpty"))).toBeTruthy()
		expect(startCompressWithCard).not.toHaveBeenCalled()
	})

	it("refuses a password longer than archives allow", async () => {
		await renderDialog([dir("Docs")])

		fireEvent.click(screen.getByRole("switch", { name: "Protect with a password" }))
		type("Password", "a".repeat(1025))

		expect(screen.getByText(i18n.t("archive:archivePasswordTooLong", { max: 1024 }))).toBeTruthy()
	})

	it("offers no Afterwards in Shared by me, whose items the SDK won't remove", async () => {
		await renderDialog([dir("Docs")], "sharedOut")

		expect(screen.queryByText("Afterwards")).toBeNull()
	})
})
