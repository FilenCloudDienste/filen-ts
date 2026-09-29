// Pure keydown-guard logic for previewOverlay.tsx's own in-dialog onKeyDown — extracted (like every
// other viewer's own *.logic.ts sibling, e.g. docxViewer.logic.ts) so it is unit-testable under this
// project's DOM-free vitest environment (vitest.config.ts: environment "node", no jsdom/happy-dom).

import { type ItemActionId } from "@/features/drive/components/itemMenu.logic"
import { hasClosest } from "@/lib/domTarget"

// The header item-menu never offers Download — the header already has its own dedicated download
// button right next to the menu's own trigger (previewOverlay.tsx).
export const PREVIEW_MENU_HIDDEN_ACTION_IDS = new Set<ItemActionId>(["download"])

// Download, plus whatever the opening surface leaves out of its own menus (Photos: Move).
export function previewMenuHiddenActionIds(extra?: ReadonlySet<ItemActionId>): ReadonlySet<ItemActionId> {
	return extra === undefined ? PREVIEW_MENU_HIDDEN_ACTION_IDS : new Set([...PREVIEW_MENU_HIDDEN_ACTION_IDS, ...extra])
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

// Native <video>/<audio> controls (scrubber, play/pause, volume, ...) render inside the element's own
// UA shadow root, which retargets any bubbled event's `target` back to the host <video>/<audio> element
// itself (see previewOverlay.tsx's own isMediaTarget comment) — so a click on the scrubber is otherwise
// INDISTINGUISHABLE, by target alone, from a click on the video's own picture area. This heuristic tells
// them apart by Y position: every browser's native video controls bar sits pinned to the element's own
// bottom edge, so a click landing in that bottom band is treated as a controls interaction, never a
// chrome-toggle — a click anywhere above it is the actual picture area. Not pixel-perfect across every
// browser's own control-bar height, but conservative in the SAFE direction: worst case, a toggle near
// the very bottom of the video is swallowed as a false "controls" guess rather than a scrubber drag
// accidentally toggling chrome out from under the user.
export const VIDEO_CONTROLS_BAND_PX = 48

export function isVideoControlsBandClick(elementHeight: number, clickOffsetY: number, bandPx: number = VIDEO_CONTROLS_BAND_PX): boolean {
	return clickOffsetY >= elementHeight - bandPx
}

// The click-to-hide-chrome decision: clicking the media surface itself toggles the preview
// overlay's header (which also carries the pager's prev/next buttons — there is no separate floating
// pager control to hide) — but a click on any interactive control (a viewer's own toolbar button, a
// CodeMirror surface, ...) or on a video/audio element's own native controls band must never toggle it,
// or every ordinary interaction with those surfaces would also flicker the chrome. Pure decision table,
// no DOM: previewOverlay.tsx computes `isInteractive`/`isMedia`/`mediaControlsBandHit` from the real
// click event (hasClosest + isVideoControlsBandClick) and hands them here.
export interface ChromeToggleClick {
	// True when the click target sits inside a button/link/input, a text-selection surface (a CodeMirror
	// editor or a pdf.js text layer), or any other widget that owns its own click semantics.
	isInteractive: boolean
	// True when the click target IS the <video>/<audio> element itself (isMediaTarget).
	isMedia: boolean
	// Only meaningful when `isMedia` is true — see isVideoControlsBandClick above.
	mediaControlsBandHit: boolean
}

export function shouldToggleChrome(click: ChromeToggleClick): boolean {
	if (click.isInteractive) {
		return false
	}

	if (click.isMedia && click.mediaControlsBandHit) {
		return false
	}

	return true
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
