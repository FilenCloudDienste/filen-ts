import { useEffect, useId, type KeyboardEvent } from "react"
import { useTranslation } from "react-i18next"
import { useRecordHotkeys } from "react-hotkeys-hook"
import { PencilIcon, RotateCcwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/lib/keymap/kbd"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { useActionCatalog } from "@/lib/keymap/actions"
import { conflictingActions } from "@/lib/keymap/conflicts"
import { normalizeRecordedCombo } from "@/lib/keymap/captureCombo"
import { groupShortcuts, SHORTCUT_NAMESPACES } from "@/lib/keymap/shortcutsCatalog"
import {
	beginRecording,
	clearRecording,
	clearUserCombo,
	endRecording,
	rejectRecording,
	setUserCombo,
	useOverrides,
	useRecordingRejection,
	useRecordingSession
} from "@/lib/keymap/registry"

// Module-level so the array identity is stable across renders — useRecordHotkeys memoizes its
// blacklist on that reference. Tab is a near-certain accidental capture while the "Change" button has
// focus, and it is an ordinary non-modifier token the recorder would otherwise happily save; a
// blacklisted key is skipped AND not preventDefault-ed, so Tab keeps moving focus normally. Escape is
// deliberately NOT blacklisted — it is handled at capture on this component's root, one layer
// earlier, and never reaches the recorder.
const RECORDER_BLACKLIST = ["tab"]

// The one shortcuts list in the app, rendered by BOTH surfaces (the ? dialog and Settings →
// Keyboard) so neither can drift from the other or from the registry. Propless on purpose: it reads
// the whole catalog itself.
//
// Recording is an app-wide session owned by the keymap store, not local state: the recorder and
// react-hotkeys-hook's matcher both listen on `document` and the matcher's listeners are registered
// first, so a recording can only be made safe by suppressing every action for its duration (see
// useAction.ts). The `useId()` token is what keeps that correct when two lists are mounted at once —
// the dialog can open on top of this page.
export function ShortcutsList() {
	const { t } = useTranslation([...SHORTCUT_NAMESPACES])
	const owner = useId()
	const actions = useActionCatalog()
	const overrides = useOverrides()
	const session = useRecordingSession()
	const rejection = useRecordingRejection()
	const [keys, { start, stop }] = useRecordHotkeys(false, RECORDER_BLACKLIST)

	// The session is the only source of truth for "which row is recording" — this component holds no
	// state of its own, so a session claimed by another mounted list simply reads as "not recording
	// here" instead of needing to be mirrored and re-synced.
	const recordingId = session?.owner === owner ? session.actionId : null
	// A recorded set that is still modifiers-only normalizes to null — the chord is not finished yet.
	const recorded = recordingId === null ? null : normalizeRecordedCombo(keys, isMacPlatform())
	const [blockedBy] = recorded === null || recordingId === null ? [] : conflictingActions(actions, recorded, recordingId)
	const blockedByKey = blockedBy?.descriptionKey ?? null

	// A freshly mounted list cancels whatever recording was in flight, so opening the dialog over a
	// recording settings page ends that recording instead of letting it capture the dialog's keys. On
	// unmount it ends only its own: endRecording is a no-op unless this instance still owns the
	// session, which is what stops a displaced list from clearing someone else's.
	useEffect(() => {
		clearRecording()

		return () => {
			endRecording(owner)
		}
	}, [owner])

	// The local recorder follows the store's session, never the click that started it — when another
	// list claims the session this one has to stop even though nothing here was interacted with.
	useEffect(() => {
		if (recordingId === null) {
			stop()

			return
		}

		start()
	}, [recordingId, start, stop])

	// Commit as soon as a full chord lands. Deps are primitives only: the conflicting action is
	// resolved during render and passed in as its key, so the catalog's per-render identity never
	// re-triggers this.
	useEffect(() => {
		if (recorded === null || recordingId === null) {
			return
		}

		if (blockedByKey !== null) {
			rejectRecording(owner, blockedByKey)

			return
		}

		endRecording(owner)
		void setUserCombo(recordingId, recorded)
	}, [recorded, recordingId, blockedByKey, owner])

	// Escape cancels the recording instead of being recorded or dismissing the surface around us.
	// Capture phase on our own root is the only position that beats every other listener: React
	// attaches its native capture listener on the root container (and on each portal container), so
	// this runs before the event reaches the focused button, before React's bubble dispatch (Base UI's
	// onKeyDown dismiss), and before the document listeners (Base UI's escape dismiss, and both of
	// react-hotkeys-hook's). React's stopPropagation calls the native one, so none of them see it.
	//
	// Consequence: `escape` cannot be RECORDED as a combo. It is the cancel key here, as in every
	// recorder; the shipped clearSelection defaults that use it are unaffected, and "Reset to default"
	// restores them after any rebind.
	function handleKeyDownCapture(event: KeyboardEvent) {
		if (recordingId === null || event.key !== "Escape") {
			return
		}

		event.preventDefault()
		event.stopPropagation()
		endRecording(owner)
	}

	function toggleRecording(id: string): void {
		if (recordingId === id) {
			endRecording(owner)

			return
		}

		beginRecording(owner, id)
	}

	return (
		<div
			className="flex flex-col gap-6"
			onKeyDownCapture={handleKeyDownCapture}
		>
			{groupShortcuts(actions).map(group => (
				<section key={group.scope}>
					<h3 className="px-1 pb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">{t(group.labelKey)}</h3>
					<ul className="flex flex-col">
						{group.actions.map(action => {
							const rowRecording = recordingId === action.id
							const rowConflict = rejection?.actionId === action.id ? rejection : null
							const labelId = `${owner}-${action.id}`

							return (
								<li
									key={action.id}
									data-action-id={action.id}
									className="flex min-h-10 items-center gap-2 rounded-lg px-1 py-1.5 hover:bg-muted/50"
								>
									<div className="flex min-w-0 flex-1 flex-col">
										<span
											id={labelId}
											className="truncate text-sm"
										>
											{t(action.descriptionKey)}
										</span>
										{rowConflict !== null && (
											<span className="truncate text-xs text-destructive">
												{t("shortcutsConflict", { action: t(rowConflict.conflictKey) })}
											</span>
										)}
									</div>
									<div className="flex shrink-0 items-center gap-1">
										{rowRecording ? (
											<span className="text-xs text-muted-foreground">{t("shortcutsRecording")}</span>
										) : action.combo.length > 0 ? (
											<Kbd action={action.id} />
										) : (
											<span className="text-xs text-muted-foreground">{t("shortcutsUnbound")}</span>
										)}
										{!rowRecording && overrides[action.id] !== undefined && (
											<Button
												variant="ghost"
												size="icon-sm"
												aria-label={t("shortcutsResetToDefault")}
												aria-describedby={labelId}
												onClick={() => {
													void clearUserCombo(action.id)
												}}
											>
												<RotateCcwIcon />
											</Button>
										)}
										{/* One button that toggles, never two that swap: React keeps this element (and the
										    focus on it) across the state change, which is what lets the root's Escape
										    capture handler see the keypress at all. */}
										<Button
											variant="ghost"
											size="sm"
											aria-label={rowRecording ? t("cancel") : t("shortcutsChange")}
											aria-describedby={labelId}
											onClick={() => {
												toggleRecording(action.id)
											}}
										>
											{rowRecording ? (
												t("cancel")
											) : (
												<>
													<PencilIcon />
													<span className="hidden sm:inline">{t("shortcutsChange")}</span>
												</>
											)}
										</Button>
									</div>
								</li>
							)
						})}
					</ul>
				</section>
			))}
		</div>
	)
}
