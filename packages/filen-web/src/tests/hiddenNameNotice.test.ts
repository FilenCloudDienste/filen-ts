import { beforeEach, describe, expect, it, vi } from "vitest"

const { toastInfo } = vi.hoisted(() => ({ toastInfo: vi.fn() }))

vi.mock("sonner", () => ({ toast: { info: toastInfo, success: vi.fn(), error: vi.fn() } }))

// Importing this module transitively imports @/lib/i18n, which runs its i18next.init() as a module
// side effect — the interpolated copy below is the real catalog string, no bootstrap needed.
import { notifyIfNameIsHidden } from "@/features/drive/lib/hiddenNameNotice"

beforeEach(() => {
	vi.clearAllMocks()
})

describe("notifyIfNameIsHidden", () => {
	it("stays silent when the filter does not apply to this listing", () => {
		notifyIfNameIsHidden(".env", "created", false)

		expect(toastInfo).not.toHaveBeenCalled()
	})

	it("stays silent for a name the filter would not hide", () => {
		notifyIfNameIsHidden("report.pdf", "created", true)

		expect(toastInfo).not.toHaveBeenCalled()
	})

	it("toasts once after a create, naming the setting and the menu it lives under", () => {
		notifyIfNameIsHidden(".env", "created", true)

		expect(toastInfo).toHaveBeenCalledExactlyOnceWith("Created — it won't be listed until you turn on Show hidden items under Display.")
	})

	it("toasts the rename copy after a rename", () => {
		notifyIfNameIsHidden(" .env", "renamed", true)

		expect(toastInfo).toHaveBeenCalledExactlyOnceWith("Renamed — it won't be listed until you turn on Show hidden items under Display.")
	})
})
