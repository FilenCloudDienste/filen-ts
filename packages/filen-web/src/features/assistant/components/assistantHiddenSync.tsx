import { useEffect } from "react"
import { officeSetting } from "@filen/shared"
import { loadOfficeSettings, officeSettings } from "@/features/office/lib/officeSettings"
import { assistantHiddenPreference } from "@/features/assistant/store/assistantHidden"

// The synced office settings' value as read, or null while the file was not read (the value this device kept stays).
function syncedAssistantHidden(): boolean | null {
	return officeSettings.isLoaded ? officeSetting(officeSettings.value(), "hideAssistant") : null
}

function follow(): void {
	const hidden = syncedAssistantHidden()

	if (hidden !== null) {
		assistantHiddenPreference.set(hidden)
	}
}

// For the signed-in shell: reads the synced setting once and follows changes from other devices and tabs (the
// file's socket reloads), keeping this device's copy for the next boot. Renders nothing.
export function AssistantHiddenSync(): null {
	useEffect(() => {
		const off = officeSettings.subscribe(follow)

		void loadOfficeSettings().then(follow)

		return off
	}, [])

	return null
}
