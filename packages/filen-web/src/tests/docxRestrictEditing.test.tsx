// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { DocxDocumentProtection, DocxProtectionMode, DocxProtectionSetting } from "@filen/office/core/docx/edit"
import { i18n } from "@/lib/i18n"
import { TooltipProvider } from "@/components/ui/tooltip"
import { DocxProtectButtons, type DocxProtectionControls } from "@/features/preview/components/docxRestrictEditing"

// Review > Protect: Restrict Editing, Stop Protection and Lock Tracking hand the editor what to set.

const t = i18n.getFixedT("en", "preview")

afterEach(cleanup)

function controls(mode: DocxProtectionMode, found?: DocxDocumentProtection) {
	const set = vi.fn((_setting: DocxProtectionSetting | undefined) => undefined)
	const value: DocxProtectionControls = { mode, canStart: true, read: () => found, set }

	render(
		<TooltipProvider>
			<DocxProtectButtons
				controls={value}
				lockTracking
			/>
		</TooltipProvider>
	)

	return set
}

describe("DocxProtectButtons", () => {
	it("starts the protection chosen, without a password", async () => {
		const set = controls("none")

		fireEvent.click(screen.getByRole("button", { name: t("previewDocxRestrictEditing") }))
		fireEvent.click(await screen.findByLabelText(t("previewDocxRestrictComments")))
		fireEvent.click(screen.getByLabelText(t("previewDocxRestrictFormatting")))
		fireEvent.click(screen.getByRole("button", { name: t("previewDocxRestrictAction") }))

		await waitFor(() => {
			expect(set).toHaveBeenCalledWith({ edit: "comments", formatting: true })
		})
	})

	it("locks tracking", async () => {
		const set = controls("none")

		fireEvent.click(screen.getByRole("button", { name: t("previewDocxLockTracking") }))
		fireEvent.click(await screen.findByRole("button", { name: t("previewDocxLockTrackingAction") }))

		await waitFor(() => {
			expect(set).toHaveBeenCalledWith({ edit: "trackedChanges", formatting: false })
		})
	})

	it("stops a protection without a password at once, and asks for one that has it", async () => {
		const set = controls("forms", { edit: "forms", formatting: false, password: undefined })

		fireEvent.click(screen.getByRole("button", { name: t("previewDocxStopProtection") }))

		expect(set).toHaveBeenCalledWith(undefined)
		cleanup()

		const guarded = controls("trackedChanges", {
			edit: "trackedChanges",
			formatting: false,
			password: { algorithm: "SHA-512", hash: "AA==", salt: "", spinCount: 0, input: "legacy" }
		})

		fireEvent.click(screen.getByRole("button", { name: t("previewDocxUnlockTracking") }))

		expect(await screen.findByText(t("previewDocxUnprotectBody"))).toBeTruthy()
		expect(guarded).not.toHaveBeenCalled()
	})
})
