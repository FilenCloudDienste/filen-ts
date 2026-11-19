// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"

// The Photos directory chooser's replace warning names the photos directories a pick holds as a list in the locale's
// words, never joined with a fixed comma.

vi.mock("react-i18next", async importOriginal => ({
	...(await importOriginal<typeof import("react-i18next")>()),
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) =>
			key === "photosChooserReplaceBody" ? `replaces ${String(params?.["names"])}` : key,
		i18n: { language: "de" }
	})
}))

vi.mock("@/features/drive/hooks/useDirectoryPicker", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/hooks/useDirectoryPicker")>()),
	useDirectoryPicker: () => ({
		pathStack: ["media"],
		targetUuid: "media",
		listingQuery: { status: "success", data: [], refetch: () => Promise.resolve() },
		items: [],
		namesQuery: { data: { media: "Media" } },
		descend: () => undefined,
		goRoot: () => undefined,
		goTo: () => undefined
	})
}))

vi.mock("@/queries/account", () => ({ useAccountQuery: () => ({ data: { rootDirUuid: "root" } }) }))

vi.mock("@/lib/directoryRoots", () => ({
	checkDirectoryRoot: () => Promise.resolve({ ok: false, reason: "nested", replace: ["a", "b"] })
}))

vi.mock("@/features/photos/lib/library", () => ({ addPhotosRoot: () => Promise.resolve() }))

const { DirectoryChooserDialog } = await import("@/features/photos/components/directoryChooserDialog")

describe("the Photos chooser's replace warning", () => {
	it("lists the replaced directories with the locale's conjunction", async () => {
		render(
			<DirectoryChooserDialog
				roots={[
					{ uuid: "a", name: "Camera" },
					{ uuid: "b", name: "Screenshots" }
				]}
				readOnly={false}
				onClose={() => undefined}
			/>
		)

		fireEvent.click(screen.getByRole("button", { name: "photosChooserConfirmAction" }))

		expect((await screen.findByRole("alert")).textContent).toBe("replaces Camera und Screenshots")
	})
})
