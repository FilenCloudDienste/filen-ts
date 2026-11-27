// "settings" namespace — Settings > Assistant: the on-device assistant's settings. Spread into settings.ts; same
// catalog rules (flat, camelCase, keys unique across the namespace's files, no literal '.' or ':').
export const settingsAssistant = {
	/** Settings sidebar — Assistant section nav label and that section's page heading (the on-device AI assistant) */
	settingsSectionAssistant: "Assistant",
	/** Settings > Assistant — switch label: hides every assistant button, panel and shortcut, on every device of the account */
	settingsAssistantHide: "Hide Assistant",
	/** Settings > Assistant — description of the Hide Assistant switch */
	settingsAssistantHideDescription:
		"Removes the assistant's buttons, panel and shortcuts, and never loads its model. Synced across your devices.",
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
	settingsAssistantRetentionForever: "Forever",
	/** Settings > Assistant — confirmation before a Keep conversations choice that removes saved conversations: title */
	settingsAssistantRetentionConfirmTitle: "Remove saved conversations?",
	/** Settings > Assistant — confirmation body; {{count}} is how many saved conversations the new choice removes */
	settingsAssistantRetentionConfirmBody_one: "{{count}} saved conversation is removed from this device. This can't be undone.",
	settingsAssistantRetentionConfirmBody_other: "{{count}} saved conversations are removed from this device. This can't be undone.",
	/** Settings > Assistant — confirmation body for Off when the number of saved conversations is not known yet */
	settingsAssistantRetentionConfirmOffBody: "Every saved conversation is removed from this device. This can't be undone.",
	/** Settings > Assistant — confirmation body for a shorter limit when the number of saved conversations is not known yet */
	settingsAssistantRetentionConfirmShorterBody:
		"Saved conversations older than the new limit are removed from this device. This can't be undone.",
	/** Settings > Assistant — confirmation button that applies the choice and removes the conversations */
	settingsAssistantRetentionConfirm: "Remove"
} as const
