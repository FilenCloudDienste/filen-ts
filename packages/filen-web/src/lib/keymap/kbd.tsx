import { Kbd as KbdPrimitive, KbdGroup } from "@/components/ui/kbd"
import { useComboFor } from "@/lib/keymap/registry"

interface KbdProps {
	action: string
}

// Display platform follows the real OS (what the physical keyboard says), independent of the
// keymap's own combo semantics.
const IS_MAC = typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC")

// Combo tokens are stored in react-hotkeys-hook's own vocabulary ("mod+f", "escape", …) — rendered
// as the glyphs/names a user actually sees on their keyboard.
const KEY_LABELS: Record<string, string> = {
	mod: IS_MAC ? "⌘" : "Ctrl",
	meta: IS_MAC ? "⌘" : "Win",
	ctrl: IS_MAC ? "⌃" : "Ctrl",
	alt: IS_MAC ? "⌥" : "Alt",
	shift: IS_MAC ? "⇧" : "Shift",
	escape: "Esc",
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
	const combo = useComboFor(action)
	const keys = combo
		.split("+")
		.map(key => key.trim())
		.filter(key => key.length > 0)

	return (
		<KbdGroup>
			{keys.map((key, index) => (
				<KbdPrimitive key={`${key}-${String(index)}`}>{formatKey(key)}</KbdPrimitive>
			))}
		</KbdGroup>
	)
}
