import { type LucideIcon } from "lucide-react"

// Per-action label + icon (+ destructive styling) facts, keyed by the owning feature's i18n namespace.
export interface ActionDef<K extends string> {
	labelKey: K
	icon: LucideIcon
	destructive?: boolean
}

// One menu/bulk-bar entry. "direct" runs immediately; "dialog" opens the surface's dialog host on
// dialogKind. A discriminated union rather than an optional dialogKind, so a caller can never observe
// an inconsistent combination. Arm adds surface-specific run arms (notes' submenu).
export type ActionDescriptor<K extends string, Id extends string, DialogKind extends string, Arm = never> = ActionDef<K> & {
	id: Id
} & ({ run: "direct" } | { run: "dialog"; dialogKind: DialogKind } | Arm)
