// Pure keydown-guard logic for previewOverlay.tsx's own in-dialog onKeyDown — extracted (like every
// other viewer's own *.logic.ts sibling, e.g. docxViewer.logic.ts) so it is unit-testable under this
// project's DOM-free vitest environment (vitest.config.ts: environment "node", no jsdom/happy-dom).

import { type ItemActionId } from "@/features/drive/components/itemMenu.logic"
import { hasClosest } from "@/lib/domTarget"
import type { DriveVariant } from "@/features/drive/lib/preferences"

// The header item-menu never offers Download — the header already has its own dedicated download
// button right next to the menu's own trigger (previewOverlay.tsx).
export const PREVIEW_MENU_HIDDEN_ACTION_IDS = new Set<ItemActionId>(["download"])

// Download, plus whatever the opening surface leaves out of its own menus (Photos: Move), plus Download as where the
// file may not be downloaded (previewDownloadable): it is a download too.
export function previewMenuHiddenActionIds(extra?: ReadonlySet<ItemActionId>, downloadable = true): ReadonlySet<ItemActionId> {
	if (extra === undefined && downloadable) {
		return PREVIEW_MENU_HIDDEN_ACTION_IDS
	}

	return new Set<ItemActionId>([...PREVIEW_MENU_HIDDEN_ACTION_IDS, ...(extra ?? []), ...(downloadable ? [] : ["downloadAs" as const])])
}

// True while `target` sits inside a CodeMirror surface (editable OR read-only alike) — CodeMirror's
// own Left/Right/Home/End bindings move the cursor/selection and never call stopPropagation (verified
// against the installed @codemirror/view build), so without this guard the SAME keypress that moves
// the caret also bubbles into the pager's own onKeyDown and pages away — or, while a dirty editable
// buffer is open, pops the unsaved-changes prompt on every single press.
//
// Checked on CodeMirror's own ".cm-editor" root class REGARDLESS of read-only: `readOnly` blocks EDITS
// only, not caret/selection movement, so a read-only text/code preview keeps its native arrow-key
// navigation once focus is inside it too — the pager buttons (or stepping back out to the listing)
// remain how you page one of those instead, exactly like a focused <video>/<audio> scrubber already
// claims Left/Right for seeking (see previewOverlay.tsx's own isMediaTarget).
//
// Any text field too (a caret moves there as well), and a surface marked `data-preview-surface`: one that
// takes its own clicks and arrow keys, as the spreadsheet grid does, where an arrow at the sheet's edge
// stays put rather than paging away.
export const PREVIEW_SURFACE = "[data-preview-surface]"

export function isTextEditingTarget(target: EventTarget | null): boolean {
	return hasClosest(target) && target.closest(`.cm-editor, input, textarea, ${PREVIEW_SURFACE}`) !== null
}

// What close/prev/next resolve to once an unsaved-changes prompt is answered — the SAME confirm dialog
// serves all three trigger points (Escape/backdrop/X, the two pager buttons, and the in-dialog arrow
// keys), so this is the only state needed to remember which of them was actually requested.
export type PreviewDismissIntent = "close" | "prev" | "next"

// Only a navigation that leaves this route ever unmounts the overlay (and with it the dirty buffer):
// a same-route param change — a deeper /drive/$ splat — re-renders the listing in place with the
// dialog host, the frozen pager snapshot and the editor buffer all intact. Prompting there would
// claim a loss that never happens.
export function previewNavigationUnmountsOverlay(currentRouteId: string, nextRouteId: string): boolean {
	return currentRouteId !== nextRouteId
}

// What one "Discard" answer has to do. Not a precedence ranking: a blocked navigation and a waiting
// sign-out can both be live (a force-logout can arrive while the navigation prompt is already up),
// and each holds a promise someone is awaiting, so both get released by the same answer. The queued
// in-app intent is dropped whenever either external waiter is released — the overlay is going away on
// that path regardless, so stepping the pager first would be a visible flicker with no meaning.
export interface UnsavedConfirmActions {
	proceedNavigation: boolean
	proceedLogout: boolean
	intent: PreviewDismissIntent | null
}

export function resolveUnsavedConfirm(
	pendingIntent: PreviewDismissIntent | null,
	navigationBlocked: boolean,
	logoutRequested: boolean
): UnsavedConfirmActions {
	return {
		proceedNavigation: navigationBlocked,
		proceedLogout: logoutRequested,
		intent: navigationBlocked || logoutRequested ? null : pendingIntent
	}
}

// One prompt for all five trigger vectors (close/prev/next, a blocked navigation, a waiting sign-out),
// so a second one can never stack behind the first.
export function unsavedPromptOpen(
	pendingIntent: PreviewDismissIntent | null,
	navigationBlocked: boolean,
	logoutRequested: boolean
): boolean {
	return pendingIntent !== null || navigationBlocked || logoutRequested
}

// Which item a slot's pin is taken from now, or null to keep the one it holds: a new document takes it from the
// item on screen; a pin taken while a probe still had to tell TypeScript from a transport stream (no viewer
// mounted) takes it again once the verdict lands, from the item as it was pinned, so a rename meanwhile
// changes nothing. Any other verdict leaves a mounted viewer be.
export function slotPinSource<T>(
	pinned: { documentKey: string; item: T; verdict: string | undefined; awaitingVerdict: boolean } | null,
	current: { documentKey: string; item: T | undefined; verdict: string | undefined }
): T | null {
	if (pinned?.documentKey !== current.documentKey) {
		return current.item ?? null
	}

	return pinned.awaitingVerdict && pinned.verdict !== current.verdict ? pinned.item : null
}

// Whether the preview offers the file's own bytes (its Download, and what viewers make of it: a PDF, a CSV): never a
// file its share does not let be downloaded, never one in the trash.
export function previewDownloadable(downloadable: boolean, variant: DriveVariant): boolean {
	return downloadable && variant !== "trash"
}

// An Escape pressed while a menu is still opening, before it takes focus and the key, was meant for that menu.
export function menuOpening(root: ParentNode): boolean {
	return root.querySelector('[aria-haspopup="menu"][aria-expanded="true"]') !== null
}
