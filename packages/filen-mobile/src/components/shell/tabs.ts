export const TABS = [
	{
		name: "drive",
		labelKey: "tab_drive",
		sf: "folder.fill",
		md: "folder"
	},
	{
		name: "photos",
		labelKey: "tab_photos",
		sf: "photo.fill",
		md: "photo-library"
	},
	{
		name: "notes",
		labelKey: "tab_notes",
		sf: "note.text",
		md: "book"
	},
	{
		name: "chats",
		labelKey: "tab_chats",
		sf: "message.fill",
		md: "messenger"
	},
	{
		name: "more",
		labelKey: "tab_more",
		sf: "ellipsis",
		md: "more-horiz"
	}
] as const

export type TabLabelKey = (typeof TABS)[number]["labelKey"]

export function tabLabelKey(name: string | undefined): TabLabelKey | null {
	return TABS.find(tab => tab.name === name)?.labelKey ?? null
}
