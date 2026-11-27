import { type LucideIcon } from "lucide-react"

// Per-action label + icon (+ destructive styling) facts, keyed by the owning feature's i18n namespace.
export interface ActionDef<K extends string> {
	labelKey: K
	icon: LucideIcon
	destructive?: boolean
}

// The reason an entry gives for being disabled offline, on every surface alike.
export const OFFLINE_REASON_KEY = "common:offlineActionDisabled"

// What a builder may attach beyond label and run: `enabled: false` shows the entry disabled (never absent), with
// `disabledReasonKey` as its explanation; `kbdAction` is the keymap action whose keys run it; `pinned` keeps it on a
// selection bar's face rather than in the bar's overflow menu.
export interface ActionState<K extends string> {
	enabled?: boolean
	disabledReasonKey?: K | typeof OFFLINE_REASON_KEY
	kbdAction?: string
	pinned?: boolean
}

// One menu/bulk-bar entry. "direct" runs immediately; "dialog" opens the surface's dialog host on
// dialogKind. A discriminated union rather than an optional dialogKind, so a caller can never observe
// an inconsistent combination. Arm adds surface-specific run arms (notes' submenu).
export type ActionDescriptor<K extends string, Id extends string, DialogKind extends string, Arm = never> = ActionDef<K> &
	ActionState<K> & {
		id: Id
	} & ({ run: "direct" } | { run: "dialog"; dialogKind: DialogKind } | Arm)
