// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import {
	OFFICE_SETTINGS_FILE_NAME,
	officeAuthorName,
	officeAutosave,
	officeSetting,
	setOfficeSetting,
	parseOfficeSettings,
	serializeOfficeSettings,
	setAuthorName,
	emptyOfficeSettings
} from "@filen/shared"
import { driveFile } from "@/tests/support/videoDrive"

const OFFICE = "00000000-0000-4000-8000-0000000000f2"

// A drive whose `.filen/office` holds the settings file once uploaded (or `initial` from the start).
const drive = vi.hoisted(() => ({
	text: undefined as string | undefined,
	uploads: [] as string[],
	counter: 0,
	lists: 0
}))

vi.mock("@/lib/dotFilen", () => ({
	dotFilenSubdirUuid: () => (drive.text === undefined ? null : OFFICE),
	findDotFilenSubdir: () => Promise.resolve(drive.text === undefined ? null : OFFICE),
	getDotFilenSubdir: () => Promise.resolve(OFFICE),
	noteDotFilenFile: () => undefined,
	onDotFilenSubdirForgotten: () => () => undefined
}))

vi.mock("@/lib/sdk/socket", () => ({ registerSocketHandler: () => () => undefined }))

function headFile() {
	return driveFile(OFFICE, OFFICE_SETTINGS_FILE_NAME, {
		uuid: `00000000-0000-4000-8000-${String(drive.counter).padStart(12, "0")}`,
		timestamp: drive.counter,
		size: drive.text?.length ?? 0
	})
}

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: {
		listDirectory: () => {
			drive.lists++

			return Promise.resolve({ files: drive.text === undefined ? [] : [headFile()], dirs: [] })
		},
		downloadFileBytes: () => Promise.resolve(new TextEncoder().encode(drive.text ?? "{}")),
		uploadFileBytes: (_parent: string, bytes: Uint8Array) => {
			drive.text = new TextDecoder().decode(bytes)
			drive.uploads.push(drive.text)
			drive.counter++

			return Promise.resolve(headFile())
		}
	}
}))

const {
	ensureAuthorName,
	officeSettings,
	useOfficeSettings,
	saveOfficeAutosave,
	saveOfficeSetting,
	loadOfficeSettings,
	loadedOfficeSetting,
	resetOfficeSettings
} = await import("@/features/office/lib/officeSettings")
const { regionalLanguage, loadedRegionalLanguage } = await import("@/features/office/lib/regionalFormat")
const { listDotFilenDirectory: listOfficeDirectory } = await import("@/lib/dotFilenDirectory")

describe("office settings", () => {
	beforeEach(() => {
		resetOfficeSettings()
		drive.text = undefined
		drive.uploads = []
		drive.counter = 0
	})

	it("asks once for an author name, stores it and asks no more", async () => {
		const ask = vi.fn(() => Promise.resolve("  Jane   Doe "))

		expect(await ensureAuthorName(ask)).toBe("Jane Doe")
		expect(await ensureAuthorName(ask)).toBe("Jane Doe")
		expect(ask).toHaveBeenCalledTimes(1)
		await vi.waitFor(() => {
			expect(drive.uploads).toHaveLength(1)
		})
		expect(officeAuthorName(parseOfficeSettings(drive.uploads[0] ?? ""))).toBe("Jane Doe")
	})

	it("shares one question between concurrent callers and asks again after a refusal", async () => {
		let answer: (name: string | null) => void = () => undefined
		const ask = vi.fn(
			() =>
				new Promise<string | null>(resolve => {
					answer = resolve
				})
		)
		const first = ensureAuthorName(ask)
		const second = ensureAuthorName(ask)

		await vi.waitFor(() => {
			expect(ask).toHaveBeenCalledTimes(1)
		})
		answer(null)
		expect(await first).toBeNull()
		expect(await second).toBeNull()
		expect(drive.uploads).toEqual([])

		const again = vi.fn(() => Promise.resolve("Joan"))

		expect(await ensureAuthorName(again)).toBe("Joan")
		expect(again).toHaveBeenCalledTimes(1)
	})

	it("drops a question whose asker closed, and one that failed, so the next change asks again", async () => {
		const controller = new AbortController()
		// Never answered: its editor closed before the dialog could show.
		const lost = vi.fn(() => new Promise<string | null>(() => undefined))
		const pending = ensureAuthorName(lost, controller.signal)

		await vi.waitFor(() => {
			expect(lost).toHaveBeenCalledTimes(1)
		})
		controller.abort()
		expect(await pending).toBeNull()
		expect(await ensureAuthorName(lost, controller.signal)).toBeNull()

		const failing = vi.fn(() => Promise.reject(new Error("dialog gone")))

		expect(await ensureAuthorName(failing)).toBeNull()

		const again = vi.fn(() => Promise.resolve("Joan"))

		expect(await ensureAuthorName(again)).toBe("Joan")
		expect(again).toHaveBeenCalledTimes(1)
	})

	it("uses a name another device set, without asking", async () => {
		drive.text = serializeOfficeSettings(setAuthorName(emptyOfficeSettings(), "Remote Name", 5))
		drive.counter = 1

		const ask = vi.fn(() => Promise.resolve("Local"))

		expect(await ensureAuthorName(ask)).toBe("Remote Name")
		expect(ask).not.toHaveBeenCalled()
	})

	it("keeps autosave on by default and syncs a change", async () => {
		await officeSettings.load()
		expect(officeSettings.value().registers.has("autosave")).toBe(false)

		await saveOfficeAutosave(false)
		expect(officeAutosave(parseOfficeSettings(drive.uploads.at(-1) ?? ""))).toBe(false)
	})

	it("syncs the other settings, and hands the regional format to the spreadsheets", async () => {
		drive.text = serializeOfficeSettings(setOfficeSetting(emptyOfficeSettings(), "regionalFormat", "de-CH", 5))

		expect(await loadedRegionalLanguage()).toBe("de-CH")
		expect(await loadedOfficeSetting("paperSize")).toBeNull()

		await saveOfficeSetting("paperSize", "letter")
		await saveOfficeSetting("regionalFormat", null)

		const stored = parseOfficeSettings(drive.uploads.at(-1) ?? "")

		expect(officeSetting(stored, "paperSize")).toBe("letter")
		expect(officeSetting(stored, "regionalFormat")).toBeNull()
		// Not chosen: the browser's.
		expect(regionalLanguage()).not.toBe("de-CH")

		// Signed out: nothing of the account's choice stays.
		await saveOfficeSetting("regionalFormat", "fr-FR")
		resetOfficeSettings()
		expect(regionalLanguage()).not.toBe("fr-FR")
	})

	it("is settled after a read that failed, so spelling goes ahead on the defaults", async () => {
		vi.spyOn(officeSettings, "load").mockRejectedValueOnce(new Error("offline"))

		const { result } = renderHook(() => useOfficeSettings())

		expect(result.current.settled).toBe(false)
		await act(() => loadOfficeSettings())
		expect(result.current).toMatchObject({ loaded: false, settled: true, spellCheck: true })
	})

	it("lists the directory once for every file read from it at the same time (a reconnect)", async () => {
		drive.lists = 0

		const [a, b] = await Promise.all([listOfficeDirectory(OFFICE), listOfficeDirectory(OFFICE)])

		expect(a).toBe(b)
		expect(drive.lists).toBe(1)
		// A later read lists again (nothing is kept past the listing).
		await listOfficeDirectory(OFFICE)
		expect(drive.lists).toBe(2)
	})

	it("never shares a listing that started before the caller heard of a change", async () => {
		drive.lists = 0

		const early = listOfficeDirectory(OFFICE, 0)
		// A change heard after that listing started: a new one.
		const fresh = listOfficeDirectory(OFFICE, performance.now() + 1)
		// Heard before the new one started: shares it.
		const shared = listOfficeDirectory(OFFICE, 0)

		expect(fresh).not.toBe(early)
		expect(shared).toBe(fresh)
		await Promise.all([early, fresh, shared])
		expect(drive.lists).toBe(2)
	})
})
