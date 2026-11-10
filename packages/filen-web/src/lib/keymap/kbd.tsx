import { chordLabels, formatChord, parseCombo } from "@filen/shared/keymap"
import { Kbd as KbdPrimitive, KbdGroup } from "@/components/ui/kbd"
import { useComboFor } from "@/lib/keymap/registry"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { useKeyboardLayout } from "@/lib/keymap/layout"

interface KbdProps {
	action: string
}

const IS_MAC = isMacPlatform()

// Every place a shortcut is mentioned in the UI (menus, tooltips, empty states, …) renders the
// combo actually in effect — default OR user override — via the same registry `useAction` reads
// from, split into one shadcn `<Kbd>` badge per key (`npx shadcn@latest add @shadcn/kbd` — already
// available as a registry component, so nothing here is hand-rolled) inside a `<KbdGroup>`,
// matching the component's own documented multi-key usage.
export function Kbd({ action }: KbdProps) {
	// One group per ALTERNATIVE, separated by a muted slash: "delete,backspace" is two keys that both
	// work, and rendering only the first (or joining them into one badge) misreports the real binding.
	// Keys are physical (@filen/shared/keymap), labelled with what the user's layout prints on them.
	const chords = parseCombo(useComboFor(action))
	const layout = useKeyboardLayout()

	return (
		<span className="inline-flex items-center gap-1">
			{chords.map((chord, alternativeIndex) => (
				<span
					key={formatChord(chord)}
					className="inline-flex items-center gap-1"
				>
					{alternativeIndex > 0 && <span className="text-muted-foreground/60">/</span>}
					<KbdGroup>
						{chordLabels(chord, IS_MAC, layout).map((label, index) => (
							<KbdPrimitive key={`${label}-${String(index)}`}>{label}</KbdPrimitive>
						))}
					</KbdGroup>
				</span>
			))}
		</span>
	)
}

// A shortcut that is not a keymap action (an embedded editor's own, already in display labels).
export function KbdKeys({ keys }: { keys: readonly string[] }) {
	return (
		<KbdGroup>
			{keys.map((key, index) => (
				<KbdPrimitive key={`${key}-${String(index)}`}>{key}</KbdPrimitive>
			))}
		</KbdGroup>
	)
}
