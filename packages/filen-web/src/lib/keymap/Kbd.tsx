import { Kbd as KbdPrimitive, KbdGroup } from "@/components/ui/kbd"
import { useComboFor } from "@/lib/keymap/registry"

interface KbdProps {
	action: string
}

function formatKey(key: string): string {
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
