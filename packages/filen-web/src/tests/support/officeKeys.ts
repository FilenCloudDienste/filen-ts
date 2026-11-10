import { OFFICE_ACTIONS } from "@/features/office/lib/keymap"
import { registerAction, registeredAction } from "@/lib/keymap/registry"

// The office ribbon's keys, as the app's boot registers them, for a suite that renders a ribbon without the whole
// action set. Importing it registers them once.
for (const def of OFFICE_ACTIONS) {
	if (registeredAction(def.id) === undefined) {
		registerAction(def)
	}
}
