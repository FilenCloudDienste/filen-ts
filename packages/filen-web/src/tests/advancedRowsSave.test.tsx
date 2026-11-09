// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ComponentType } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"

// Each Advanced row writes one locally stored setting: a failed write must say so, and the restart note
// is only for a value that was stored. The row primitives are stubbed down to one button that fires the
// change, so the rows' own write handling is what runs.
const { setHeic, setDotFilen, setTransfer, setArchive, refetch } = vi.hoisted(() => ({
	setHeic: vi.fn<(next: boolean) => Promise<void>>(),
	setDotFilen: vi.fn<(next: boolean) => Promise<void>>(),
	setTransfer: vi.fn<(next: unknown) => Promise<void>>(),
	setArchive: vi.fn<(next: unknown) => Promise<void>>(),
	refetch: vi.fn()
}))

vi.mock("@/features/drive/lib/heicUpload", () => ({ setHeicUploadConvertPreference: setHeic }))
vi.mock("@/features/drive/lib/preferences", () => ({ DEFAULT_SHOW_DOT_FILEN: false, setShowDotFilen: setDotFilen }))
vi.mock("@/features/settings/lib/transferConfig", () => ({ setTransferPreferences: setTransfer }))
vi.mock("@/features/settings/lib/archiveConfig", () => ({
	setArchivePreferences: setArchive,
	ARCHIVE_CODEC_MEMORY_MIB: [64, 128],
	DEFAULT_ARCHIVE_PREFERENCES: { codecMemoryMib: 64 }
}))
vi.mock("@/features/drive/lib/archiveHelpers", () => ({ archiveCodecMemBudget: () => new Promise(() => undefined) }))
vi.mock("@/features/drive/queries/drive", () => ({
	useHeicUploadConvertPreferenceQuery: () => ({ data: false, refetch }),
	useShowDotFilenPreferenceQuery: () => ({ data: false, refetch })
}))
vi.mock("@/features/settings/queries/preferences", () => ({
	useTransferPreferencesQuery: () => ({ data: { preset: "balanced" }, isFetching: false, refetch }),
	useArchivePreferencesQuery: () => ({ data: { codecMemoryMib: 64 }, isFetching: false, refetch })
}))
vi.mock("@/features/settings/components/settingRows", () => ({
	PreferenceToggleRow: ({ onCheckedChange }: { onCheckedChange: (checked: boolean) => void }) =>
		createElement(
			"button",
			{
				type: "button",
				onClick: () => {
					onCheckedChange(true)
				}
			},
			"change"
		),
	SettingsSelectRow: ({ options, onChange }: { options: { value: string }[]; onChange: (value: string) => void }) =>
		createElement(
			"button",
			{
				type: "button",
				onClick: () => {
					onChange(options.at(-1)?.value ?? "")
				}
			},
			"change"
		)
}))

const { toastError, toastInfo } = vi.hoisted(() => ({ toastError: vi.fn(), toastInfo: vi.fn() }))

vi.mock("sonner", () => ({ toast: { error: toastError, info: toastInfo } }))

import "@/lib/i18n"
import { settings as EN_SETTINGS } from "@/locales/en/settings"
import { UploadsRow } from "@/features/settings/components/advanced/uploadsRow"
import { DotFilenRow } from "@/features/settings/components/advanced/dotFilenRow"
import { TransferConfigRow } from "@/features/settings/components/advanced/transferConfigRow"
import { ArchiveMemoryRow } from "@/features/settings/components/advanced/archiveMemoryRow"

const ROWS: [string, ComponentType, typeof setHeic | typeof setTransfer, boolean][] = [
	["uploads", UploadsRow, setHeic, false],
	["dot-filen", DotFilenRow, setDotFilen, false],
	["transfer preset", TransferConfigRow, setTransfer, true],
	["archive memory", ArchiveMemoryRow, setArchive, true]
]

async function change(): Promise<void> {
	fireEvent.click(screen.getByRole("button", { name: "change" }))
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0))
	})
}

beforeEach(() => {
	for (const set of [setHeic, setDotFilen, setTransfer, setArchive]) {
		set.mockResolvedValue(undefined)
	}
})

describe.each(ROWS)("the %s row", (_, Row, set, restartNote) => {
	it("says the setting could not be saved, and nothing else, when the write fails", async () => {
		set.mockRejectedValue(new Error("storage"))
		render(createElement(Row))

		await change()

		expect(toastError).toHaveBeenCalledExactlyOnceWith(EN_SETTINGS.settingsDocumentsSaveFailed)
		expect(toastInfo).not.toHaveBeenCalled()
		expect(refetch).not.toHaveBeenCalled()
	})

	it("re-reads the stored value once written", async () => {
		render(createElement(Row))

		await change()

		expect(set).toHaveBeenCalledOnce()
		expect(refetch).toHaveBeenCalledOnce()
		expect(toastError).not.toHaveBeenCalled()

		if (restartNote) {
			expect(toastInfo).toHaveBeenCalledExactlyOnceWith(EN_SETTINGS.settingsAdvancedRestartRequired)
		}
	})
})
