// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"

const { native, heicPreference, startUploads, startDirectoryUpload } = vi.hoisted(() => ({
	native: {
		available: vi.fn(() => true),
		pick: Promise.withResolvers<undefined>(),
		pickNativeUpload: vi.fn((_kind: string, _parentUuid: string | null): Promise<undefined> => native.pick.promise),
		startNativeUploads: vi.fn((_files: File[], _parentUuid: string | null, _options?: { asDirectory?: boolean }) => Promise.resolve())
	},
	heicPreference: { value: undefined as boolean | undefined },
	startUploads: vi.fn(),
	startDirectoryUpload: vi.fn()
}))

vi.mock("@/features/transfers/lib/nativeHost", () => ({ nativeTransfersAvailable: native.available }))
vi.mock("@/features/transfers/lib/nativeTransfers", () => ({
	pickNativeUpload: native.pickNativeUpload,
	startNativeUploads: native.startNativeUploads
}))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/features/drive/lib/upload", () => ({ startUploads }))
vi.mock("@/features/drive/lib/uploadDirectory", () => ({ startDirectoryUpload }))
vi.mock("@/features/drive/queries/drive", () => ({
	driveListingQueryUpdate: vi.fn(),
	heicUploadConvertPreferenceCached: () => heicPreference.value
}))

import "@/lib/i18n"
import { useUploadMenuActions } from "@/features/drive/hooks/useUploadMenuActions"

function Harness() {
	const actions = useUploadMenuActions({ parentUuid: "parent", disabled: false, openPreview: vi.fn(), hiddenNotice: false })

	return (
		<>
			{actions.host}
			<button
				type="button"
				onClick={actions.pickFiles}
			>
				files
			</button>
			<button
				type="button"
				onClick={actions.pickDirectory}
			>
				directory
			</button>
			<span>{actions.busy ? "busy" : "idle"}</span>
		</>
	)
}

let click: MockInstance<() => void>

beforeEach(() => {
	vi.clearAllMocks()
	native.available.mockReturnValue(true)
	native.pick = Promise.withResolvers<undefined>()
	heicPreference.value = undefined
	click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined)
})

afterEach(() => {
	click.mockRestore()
	cleanup()
})

describe("upload menu pickers on desktop", () => {
	it("opens native dialogs when conversion is off and clears pickerOpen when the dialog settles", async () => {
		heicPreference.value = false
		render(<Harness />)
		fireEvent.click(screen.getByRole("button", { name: "directory" }))

		expect(native.pickNativeUpload).toHaveBeenCalledWith("directory", "parent")
		expect(click).not.toHaveBeenCalled()
		expect(screen.getByText("busy")).toBeTruthy()

		await act(async () => {
			native.pick.resolve(undefined)
			await native.pick.promise
		})

		expect(screen.getByText("idle")).toBeTruthy()
	})

	it("clicks the hidden input synchronously when conversion is on or not yet read, then uploads natively", () => {
		heicPreference.value = true
		render(<Harness />)
		fireEvent.click(screen.getByRole("button", { name: "files" }))

		expect(click).toHaveBeenCalledOnce()
		expect(native.pickNativeUpload).not.toHaveBeenCalled()

		heicPreference.value = undefined
		fireEvent.click(screen.getByRole("button", { name: "directory" }))
		expect(click).toHaveBeenCalledTimes(2)

		const file = new File(["x"], "a.heic")

		fireEvent.change(screen.getByTestId("drive-upload-directory-input"), { target: { files: [file] } })

		expect(native.startNativeUploads).toHaveBeenCalledWith([file], "parent", { asDirectory: true })
		expect(startDirectoryUpload).not.toHaveBeenCalled()
	})

	it("in a browser the inputs upload through the web path", () => {
		native.available.mockReturnValue(false)
		heicPreference.value = false
		render(<Harness />)
		fireEvent.click(screen.getByRole("button", { name: "files" }))

		const file = new File(["x"], "a.txt")

		fireEvent.change(screen.getByTestId("drive-upload-files-input"), { target: { files: [file] } })

		expect(click).toHaveBeenCalledOnce()
		expect(native.pickNativeUpload).not.toHaveBeenCalled()
		expect(startUploads).toHaveBeenCalledWith([file], "parent")
	})
})
