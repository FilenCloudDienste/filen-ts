// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { createElement, type ComponentType } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"

// A failed Advanced-row write reaches the log viewer once (an exported bug report carries it), next to
// its one toast, and no restart note follows it. The row primitives are stubbed down to one button that
// fires the change, so the rows' own write handling is what runs.
const { setHeic, setDotFilen, setTransfer, setArchive, refetch } = vi.hoisted(() => ({
	setHeic: vi.fn<(next: boolean) => Promise<void>>(),
	setDotFilen: vi.fn<(next: boolean) => Promise<void>>(),
	setTransfer: vi.fn<(next: unknown) => Promise<void>>(),
	setArchive: vi.fn<(next: unknown) => Promise<void>>(),
	refetch: vi.fn()
}))

vi.mock("@/features/drive/lib/heicUpload", () => ({ setHeicUploadConvertPreference: setHeic }))
vi.mock("@/features/drive/lib/preferences", () => ({ DEFAULT_SHOW_DOT_FILEN: false, setShowDotFilen: setDotFilen }))
vi.mock("@/features/settings/lib/transferConfig", () => ({
	setTransferPreferences: setTransfer,
	buildJsClientConfig: () => ({ concurrency: 1, fileIoMemoryBudget: 1, rateLimitPerSec: 1 }),
	rememberAppliedTransferConfig: vi.fn()
}))
vi.mock("@/features/drive/lib/saveDownload", () => ({ forgetSwClientHandoff: vi.fn() }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: { applyTransferConfig: () => Promise.resolve() } }))
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

const { toastError, toastInfo, warn } = vi.hoisted(() => ({ toastError: vi.fn(), toastInfo: vi.fn(), warn: vi.fn() }))

vi.mock("sonner", () => ({ toast: { error: toastError, info: toastInfo } }))
vi.mock("@/lib/log", () => ({ log: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import "@/lib/i18n"
import { settings as EN_SETTINGS } from "@/locales/en/settings"
import { UploadsRow } from "@/features/settings/components/advanced/uploadsRow"
import { DotFilenRow } from "@/features/settings/components/advanced/dotFilenRow"
import { TransferConfigRow } from "@/features/settings/components/advanced/transferConfigRow"
import { ArchiveMemoryRow } from "@/features/settings/components/advanced/archiveMemoryRow"

const ROWS: [string, ComponentType, typeof setHeic | typeof setTransfer][] = [
	["uploads", UploadsRow, setHeic],
	["dot-filen", DotFilenRow, setDotFilen],
	["transfer preset", TransferConfigRow, setTransfer],
	["archive memory", ArchiveMemoryRow, setArchive]
]

async function change(): Promise<void> {
	fireEvent.click(screen.getByRole("button", { name: "change" }))
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0))
	})
}

describe.each(ROWS)("the %s row", (_, Row, set) => {
	it("logs a failed write once, toasts it once and shows no restart note", async () => {
		set.mockRejectedValue(new Error("storage"))
		render(createElement(Row))

		await change()

		expect(warn).toHaveBeenCalledExactlyOnceWith("settings", "setting write failed", "storage")
		expect(toastError).toHaveBeenCalledExactlyOnceWith(EN_SETTINGS.settingsDocumentsSaveFailed)
		expect(toastInfo).not.toHaveBeenCalled()
		expect(refetch).not.toHaveBeenCalled()
	})

	it("logs nothing for a stored write", async () => {
		set.mockResolvedValue(undefined)
		render(createElement(Row))

		await change()

		expect(warn).not.toHaveBeenCalled()
		expect(refetch).toHaveBeenCalledOnce()
	})
})
