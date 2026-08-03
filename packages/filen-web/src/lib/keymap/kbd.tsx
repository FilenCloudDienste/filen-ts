import { Kbd as KbdPrimitive, KbdGroup } from "@/components/ui/kbd"
import { useComboFor } from "@/lib/keymap/registry"
import { comboAlternatives, isMacPlatform } from "@/lib/keymap/kbd.logic"

interface KbdProps {
	action: string
}

const IS_MAC = isMacPlatform()

// Combo tokens are stored in react-hotkeys-hook's own vocabulary ("mod+f", "escape", …) — rendered
// as the glyphs/names a user actually sees on their keyboard.
const KEY_LABELS: Record<string, string> = {
	mod: IS_MAC ? "⌘" : "Ctrl",
	meta: IS_MAC ? "⌘" : "Win",
	ctrl: IS_MAC ? "⌃" : "Ctrl",
	alt: IS_MAC ? "⌥" : "Alt",
	shift: IS_MAC ? "⇧" : "Shift",
	escape: "Esc",
	slash: "/",
	backspace: "⌫",
	delete: IS_MAC ? "⌦" : "Del",
	enter: "↵",
	arrowup: "↑",
	arrowdown: "↓",
	arrowleft: "←",
	arrowright: "→"
}

function formatKey(key: string): string {
	const label = KEY_LABELS[key.toLowerCase()]

	if (label !== undefined) {
		return label
	}

	const [first, ...rest] = key
	return first === undefined ? key : first.toUpperCase() + rest.join("")
}

// Every place a shortcut is mentioned in the UI (menus, tooltips, empty states, …) renders the
// combo actually in effect — default OR user override — via the same registry `useAction` reads
// from, split into one shadcn `<Kbd>` badge per key (`npx shadcn@latest add @shadcn/kbd` — already
// available as a registry component, so nothing here is hand-rolled) inside a `<KbdGroup>`,
// matching the component's own documented multi-key usage.
export function Kbd({ action }: KbdProps) {
	// One group per ALTERNATIVE, separated by a muted slash: "delete,backspace" is two keys that both
	// work, and rendering only the first (or joining them into one badge) misreports the real binding.
	const alternatives = comboAlternatives(useComboFor(action))

	return (
		<span className="inline-flex items-center gap-1">
			{alternatives.map((keys, alternativeIndex) => (
				<span
					key={keys.join("+")}
					className="inline-flex items-center gap-1"
				>
					{alternativeIndex > 0 && <span className="text-muted-foreground/60">/</span>}
					<KbdGroup>
						{keys.map((key, index) => (
							<KbdPrimitive key={`${key}-${String(index)}`}>{formatKey(key)}</KbdPrimitive>
						))}
					</KbdGroup>
				</span>
			))}
		</span>
	)
}
