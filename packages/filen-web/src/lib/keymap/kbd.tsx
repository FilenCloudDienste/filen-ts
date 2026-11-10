import { useTranslation } from "react-i18next"
import { chordLabels, formatChord, parseCombo, type Chord, type KeyboardLayout } from "@filen/shared/keymap"
import { Kbd as KbdPrimitive, KbdGroup } from "@/components/ui/kbd"
import { useComboFor } from "@/lib/keymap/registry"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { useKeyboardLayout } from "@/lib/keymap/layout"
import { spokenChord } from "@/lib/keymap/keyText"

interface KbdProps {
	action: string
}

const IS_MAC = isMacPlatform()
// One chord's keycaps, read by a screen reader as words rather than as glyph names ("Command Shift Z", not "place of
// interest sign").
export function ChordKeys({ chord, layout }: { chord: Chord; layout: KeyboardLayout | null }) {
	const { t } = useTranslation("settings")

	return (
		<KbdGroup>
			<span className="sr-only">{spokenChord(chord, t, layout)}</span>
			{chordLabels(chord, IS_MAC, layout).map((label, index) => (
				<KbdPrimitive
					key={`${label}-${String(index)}`}
					aria-hidden="true"
				>
					{label}
				</KbdPrimitive>
			))}
		</KbdGroup>
	)
}

// Every place a shortcut is mentioned in the UI (menus, tooltips, empty states, …) renders the combo actually in
// effect — default OR user override — via the same registry `useAction` reads from, one shadcn `<Kbd>` per key inside
// a `<KbdGroup>`. Keys are physical (@filen/shared/keymap), labelled with what the user's layout prints on them.
export function Kbd({ action }: KbdProps) {
	// One group per ALTERNATIVE, separated by a muted slash: "delete,backspace" is two keys that both work.
	const chords = parseCombo(useComboFor(action))
	const layout = useKeyboardLayout()

	return (
		<span className="inline-flex items-center gap-1">
			{chords.map((chord, alternativeIndex) => (
				<span
					key={formatChord(chord)}
					className="inline-flex items-center gap-1"
				>
					{alternativeIndex > 0 && (
						<span
							aria-hidden="true"
							className="text-muted-foreground/60"
						>
							/
						</span>
					)}
					<ChordKeys
						chord={chord}
						layout={layout}
					/>
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
