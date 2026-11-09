// "settings" namespace — announcements and maintenance notices from the remote config. Spread into settings.ts; same catalog rules (flat, camelCase, keys unique
// across the namespace's files, no literal '.' or ':').
export const settingsAnnouncements = {
	/** Screen-reader name of the strip above the app that shows a service announcement (its title and text come from the server, untranslated) */
	announcementRegionLabel: "Announcement",
	/** Accessible label and tooltip of the × button that hides the current service announcement for good */
	announcementDismiss: "Dismiss announcement",
	/** Heading of the warning strip above the app while the Filen service is under maintenance */
	maintenanceTitle: "Filen is under maintenance",
	/** Text under the maintenance heading; the strip disappears by itself when maintenance ends, so no action is offered */
	maintenanceInfo: "Some features may not work right now. This notice goes away by itself once maintenance is over."
} as const
