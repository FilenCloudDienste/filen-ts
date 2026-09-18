import type { Locator } from "@playwright/test"
import { expect } from "../fixtures"

// The precondition for typing is FOCUS, never mere visibility. An editor pane remounts whenever its
// query's `dataUpdatedAt` advances, and its key only freezes once an inflight entry exists — i.e. from
// the FIRST keystroke onward. So the window between the click and that first character is exactly the
// one in which a remount can still happen, and a remount drops focus: the keystrokes then land on
// document.body and the edit silently records nothing, failing several assertions later with no trace
// of the cause. Re-clicking until the surface actually holds focus closes that window; each inner wait
// is well under the envelope so a click dropped by a concurrent re-render retries instead of wedging.
export async function focusEditorSurface(editor: Locator): Promise<void> {
	await expect(editor).toBeVisible()

	await expect(async () => {
		await editor.click({ timeout: 10_000 })
		await expect(editor).toBeFocused({ timeout: 2_000 })
	}).toPass({ timeout: 30_000 })
}
