import { CURRENT_PLATFORM, defaultComboOn, type ActionDef } from "@/lib/keymap/registry"

// The combo in effect for `def` under `combos` (useBindings), or its default on this platform (Mod as `mac` says) for an
// action the registry does not hold yet: a surface rendered before registerAllActions still answers its keys.
export function bindingOf(combos: Readonly<Record<string, string>>, def: ActionDef, mac: boolean): string {
	return combos[def.id] ?? defaultComboOn(def, { mac, desktop: CURRENT_PLATFORM.desktop })
}
