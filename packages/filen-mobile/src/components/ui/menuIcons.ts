import type { Image as SwiftUiImage } from "@expo/ui/swift-ui"

type SystemName = React.ComponentPropsWithoutRef<typeof SwiftUiImage>["systemName"]

const ICON_SYMBOLS = {
	heart: "heart",
	pin: "pin",
	trash: "trash",
	edit: "pencil",
	delete: "xmark.circle",
	duplicate: "doc.on.doc",
	copy: "doc.on.clipboard",
	// NOT square.and.arrow.up — that is "share"; export and share appear in
	// the same drive item menu and must be distinguishable.
	export: "arrow.up.doc",
	archive: "archivebox",
	clock: "clock",
	select: "checkmark.circle",
	users: "person.2",
	tag: "tag",
	restore: "arrow.uturn.left",
	exit: "escape",
	plus: "plus",
	text: "textformat",
	richtext: "doc.plaintext",
	markdown: "arrow.down.doc",
	code: "chevron.left.slash.chevron.right",
	checklist: "checklist",
	eye: "eye",
	list: "list.bullet.rectangle",
	grid: "square.grid.2x2",
	download: "arrow.down.circle",
	import: "square.and.arrow.down",
	info: "info.circle",
	move: "folder",
	folder: "folder",
	// Distinct from "folder" on purpose: for a directory search hit, "Open" (enter it) and
	// "Open containing directory" (go to its parent) sit next to each other in the same menu.
	containingFolder: "folder.circle",
	link: "link",
	reply: "arrowshape.turn.up.left",
	mute: "speaker.slash",
	image: "photo",
	play: "play",
	pause: "pause",
	cancel: "xmark",
	openExternal: "arrow.up.forward.app",
	gear: "gearshape",
	listOrdered: "list.number",
	listBullet: "list.bullet",
	minus: "minus.circle",
	scan: "doc.viewfinder",
	upload: "arrow.up.circle",
	envelopeOpen: "envelope.open",
	camera: "camera",
	color: "paintpalette",
	share: "square.and.arrow.up",
	versions: "clock.arrow.circlepath",
	doc: "doc",
	calendar: "calendar",
	size: "ruler",
	headerH: "textformat.size",
	checkmark: "checkmark",
	queue: "text.line.last.and.arrowtriangle.forward",
	block: "nosign",
	// Drive's item Copy; "copy" (doc.on.clipboard) stays Copy link's, and both sit in the same menu.
	copyItems: "doc.on.doc",
	cut: "scissors",
	copyTo: "folder.badge.plus",
	paste: "doc.on.clipboard.fill",
	clearClipboard: "eraser",
	saveToCloud: "icloud.and.arrow.down"
} as const satisfies Record<string, SystemName>

export type Icons = keyof typeof ICON_SYMBOLS

export const iconToSwiftUiIcon = (name: Icons): SystemName => ICON_SYMBOLS[name]
