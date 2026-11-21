// "settings" namespace — Settings > Assistant: the on-device assistant's settings. Spread into settings.ts; same
// catalog rules (flat, camelCase, keys unique across the namespace's files, no literal '.' or ':').
export const settingsAssistant = {
	/** Settings sidebar — Assistant section nav label and that section's page heading (the on-device AI assistant) */
	settingsSectionAssistant: "Assistant",
	/** Settings > Assistant — group title above the rows about saved conversations */
	settingsAssistantGroupConversations: "Conversations",
	/** Settings > Assistant — row label: how long assistant conversations stay saved on this device */
	settingsAssistantRetention: "Keep conversations",
	/** Settings > Assistant — description of the Keep conversations row */
	settingsAssistantRetentionDescription:
		"How long conversations stay saved on this device after their last message. A shorter choice removes older ones right away; Off removes them all and saves none.",
	/** Settings > Assistant — Keep conversations choice: save none */
	settingsAssistantRetentionOff: "Off",
	/** Settings > Assistant — Keep conversations choice */
	settingsAssistantRetention1Day: "1 day",
	/** Settings > Assistant — Keep conversations choice */
	settingsAssistantRetention7Days: "7 days",
	/** Settings > Assistant — Keep conversations choice */
	settingsAssistantRetention30Days: "30 days",
	/** Settings > Assistant — Keep conversations choice: never removed by age */
	settingsAssistantRetentionForever: "Forever"
} as const
