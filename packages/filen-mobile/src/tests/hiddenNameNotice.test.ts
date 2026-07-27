import { vi, describe, it, expect, beforeEach } from "vitest"

const { alertsMock, readHideHiddenItems, loggerWarn } = vi.hoisted(() => ({
	alertsMock: { normal: vi.fn(), error: vi.fn() },
	readHideHiddenItems: vi.fn(async () => true),
	loggerWarn: vi.fn()
}))

vi.mock("@/lib/alerts", () => ({ default: alertsMock }))
vi.mock("@/lib/logger", () => ({ default: { warn: loggerWarn, error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock("@/features/drive/driveHiddenItems", () => ({
	isHiddenName: (name: string) => name.trim().startsWith("."),
	readHideHiddenItems
}))

import { notifyIfNameIsHidden } from "@/features/drive/components/hiddenNameNotice"
import type { TFunction } from "i18next"

// Echoes the key back so assertions can name the string the user would actually see.
const t = ((key: string) => key) as unknown as TFunction

beforeEach(() => {
	vi.clearAllMocks()
	readHideHiddenItems.mockResolvedValue(true)
})

describe("notifyIfNameIsHidden", () => {
	it("tells the user a created item will not be listed", async () => {
		await notifyIfNameIsHidden({ name: ".private", action: "created", appliesHere: true, t })

		expect(alertsMock.normal).toHaveBeenCalledWith("created_item_is_hidden")
	})

	it("uses the rename wording on the rename path — nothing was created there", async () => {
		await notifyIfNameIsHidden({ name: ".private", action: "renamed", appliesHere: true, t })

		expect(alertsMock.normal).toHaveBeenCalledWith("renamed_item_is_hidden")
	})

	it("stays silent for a name that is not hidden", async () => {
		await notifyIfNameIsHidden({ name: "notes.txt", action: "created", appliesHere: true, t })

		expect(alertsMock.normal).not.toHaveBeenCalled()
	})

	it("stays silent when the preference is off", async () => {
		readHideHiddenItems.mockResolvedValue(false)

		await notifyIfNameIsHidden({ name: ".private", action: "created", appliesHere: true, t })

		expect(alertsMock.normal).not.toHaveBeenCalled()
	})

	// The photos timeline offers rename but runs its own unfiltered pipeline, so the row stays on
	// screen — claiming "not listed" there would be untrue.
	it("stays silent where the listing does not filter, and does not even read the preference", async () => {
		await notifyIfNameIsHidden({ name: ".private", action: "renamed", appliesHere: false, t })

		expect(alertsMock.normal).not.toHaveBeenCalled()
		expect(readHideHiddenItems).not.toHaveBeenCalled()
	})

	// Last step of an action that already succeeded — a failed preference read must not surface as
	// an unhandled rejection out of a menu handler.
	it("swallows a failed preference read instead of throwing", async () => {
		readHideHiddenItems.mockRejectedValue(new Error("keychain unavailable"))

		await expect(notifyIfNameIsHidden({ name: ".private", action: "created", appliesHere: true, t })).resolves.toBeUndefined()

		expect(alertsMock.normal).not.toHaveBeenCalled()
		expect(loggerWarn).toHaveBeenCalled()
	})
})
