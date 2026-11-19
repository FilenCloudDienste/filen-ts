// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest"
import { render } from "@testing-library/react"

// Every domain's realtime handlers register once on mount and unregister on unmount; the single subscription
// starts once and outlives the host (logout stops it, a StrictMode remount must not).

const { registrars, socketBridge } = vi.hoisted(() => {
	const registrar = () => {
		const dispose = vi.fn()

		return {
			register: vi.fn(() => dispose),
			dispose
		}
	}

	return {
		registrars: {
			notes: registrar(),
			chats: registrar(),
			drive: registrar(),
			contacts: registrar(),
			general: registrar(),
			playlists: registrar(),
			dotFilen: registrar(),
			videosLibrary: registrar(),
			watchState: registrar(),
			userDictionary: registrar(),
			officeSettings: registrar(),
			savedSignatures: registrar(),
			photosLibrary: registrar(),
			directoryRoots: registrar()
		},
		socketBridge: {
			start: vi.fn(() => Promise.resolve()),
			stop: vi.fn()
		}
	}
})

vi.mock("@/lib/sdk/socket", () => ({ socketBridge }))
vi.mock("@/features/notes/lib/socketHandlers", () => ({ registerNoteSocketHandlers: registrars.notes.register }))
vi.mock("@/features/chats/lib/socketHandlers", () => ({ registerChatSocketHandlers: registrars.chats.register }))
vi.mock("@/features/drive/lib/socketHandlers", () => ({ registerDriveSocketHandlers: registrars.drive.register }))
vi.mock("@/features/contacts/lib/socketHandlers", () => ({ registerContactSocketHandlers: registrars.contacts.register }))
vi.mock("@/features/shell/lib/generalSocketHandlers", () => ({ registerGeneralSocketHandlers: registrars.general.register }))
vi.mock("@/features/audio/lib/socketHandlers", () => ({ registerPlaylistSocketHandlers: registrars.playlists.register }))
vi.mock("@/lib/dotFilen", () => ({ registerDotFilenSocketHandlers: registrars.dotFilen.register }))
vi.mock("@/features/videos/lib/library", () => ({ registerLibraryConfigSocketHandlers: registrars.videosLibrary.register }))
vi.mock("@/features/videos/lib/watchState", () => ({ registerWatchStateSocketHandlers: registrars.watchState.register }))
vi.mock("@/features/spellcheck/lib/userDictionary", () => ({
	registerUserDictionarySocketHandlers: registrars.userDictionary.register
}))
vi.mock("@/features/office/lib/officeSettings", () => ({ registerOfficeSettingsSocketHandlers: registrars.officeSettings.register }))
vi.mock("@/features/pdf/fillSign/savedSignatures", () => ({
	registerSavedSignaturesSocketHandlers: registrars.savedSignatures.register
}))
vi.mock("@/features/photos/lib/library", () => ({ registerPhotosLibrarySocketHandlers: registrars.photosLibrary.register }))
vi.mock("@/lib/directoryRoots", () => ({ registerDirectoryRootSocketHandlers: registrars.directoryRoots.register }))

const { SocketHost } = await import("@/features/shell/components/socketHost")

describe("the socket host", () => {
	it("registers every domain's handlers once and starts the subscription once", () => {
		render(<SocketHost />)

		for (const [name, { register, dispose }] of Object.entries(registrars)) {
			expect(register, name).toHaveBeenCalledTimes(1)
			expect(dispose, name).not.toHaveBeenCalled()
		}

		expect(socketBridge.start).toHaveBeenCalledTimes(1)
	})

	it("unregisters every domain's handlers on unmount and leaves the subscription running", () => {
		const { unmount } = render(<SocketHost />)

		unmount()

		for (const [name, { dispose }] of Object.entries(registrars)) {
			expect(dispose, name).toHaveBeenCalledTimes(1)
		}

		expect(socketBridge.stop).not.toHaveBeenCalled()
	})
})
