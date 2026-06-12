import { Image as SwiftUiImage } from "@expo/ui/swift-ui"

export type Icons =
	| "heart"
	| "pin"
	| "trash"
	| "edit"
	| "delete"
	| "duplicate"
	| "copy"
	| "export"
	| "archive"
	| "clock"
	| "select"
	| "user"
	| "users"
	| "tag"
	| "restore"
	| "exit"
	| "plus"
	| "plusCircle"
	| "plusSquare"
	| "text"
	| "richtext"
	| "markdown"
	| "code"
	| "checklist"
	| "search"
	| "eye"
	| "list"
	| "grid"
	| "download"
	| "import"
	| "info"
	| "move"
	| "folder"
	| "link"
	| "reply"
	| "mute"
	| "image"
	| "play"
	| "pause"
	| "cancel"
	| "openExternal"
	| "gear"
	| "listOrdered"
	| "listBullet"
	| "minus"
	| "scan"
	| "upload"
	| "envelopeOpen"
	| "camera"
	| "color"
	| "share"
	| "versions"
	| "shield"
	| "doc"
	| "calendar"
	| "size"
	| "headerH"
	| "checkmark"
	| "queue"
	| "block"

export function iconToSwiftUiIcon(name: Icons, fill?: boolean): React.ComponentPropsWithoutRef<typeof SwiftUiImage>["systemName"] {
	switch (name) {
		case "heart": {
			return fill ? "heart.fill" : "heart"
		}

		case "pin": {
			return fill ? "pin.fill" : "pin"
		}

		case "trash": {
			return fill ? "trash.fill" : "trash"
		}

		case "edit": {
			return fill ? "pencil" : "pencil"
		}

		case "delete": {
			return fill ? "xmark.circle.fill" : "xmark.circle"
		}

		case "duplicate": {
			return fill ? "doc.on.doc.fill" : "doc.on.doc"
		}

		case "copy": {
			return fill ? "doc.on.clipboard.fill" : "doc.on.clipboard"
		}

		case "export": {
			// NOT square.and.arrow.up — that is "share"; export and share appear in
			// the same drive item menu and must be distinguishable.
			return fill ? "arrow.up.doc.fill" : "arrow.up.doc"
		}

		case "archive": {
			return fill ? "archivebox.fill" : "archivebox"
		}

		case "clock": {
			return fill ? "clock.fill" : "clock"
		}

		case "select": {
			return fill ? "checkmark.circle.fill" : "checkmark.circle"
		}

		case "user": {
			return fill ? "person.fill" : "person"
		}

		case "users": {
			return fill ? "person.2.fill" : "person.2"
		}

		case "tag": {
			return fill ? "tag.fill" : "tag"
		}

		case "restore": {
			return fill ? "arrow.uturn.left" : "arrow.uturn.left"
		}

		case "exit": {
			return fill ? "escape" : "escape"
		}

		case "plus": {
			return fill ? "plus" : "plus"
		}

		case "plusCircle": {
			return fill ? "plus.circle.fill" : "plus.circle"
		}

		case "plusSquare": {
			return fill ? "plus.rectangle.fill" : "plus.rectangle"
		}

		case "text": {
			return fill ? "textformat" : "textformat"
		}

		case "richtext": {
			return fill ? "doc.plaintext.fill" : "doc.plaintext"
		}

		case "markdown": {
			return fill ? "arrow.down.doc.fill" : "arrow.down.doc"
		}

		case "code": {
			return fill ? "chevron.left.slash.chevron.right" : "chevron.left.slash.chevron.right"
		}

		case "checklist": {
			return fill ? "checklist.checked" : "checklist"
		}

		case "search": {
			return fill ? "magnifyingglass" : "magnifyingglass"
		}

		case "eye": {
			return fill ? "eye.fill" : "eye"
		}

		case "list": {
			return fill ? "list.bullet.rectangle.fill" : "list.bullet.rectangle"
		}

		case "grid": {
			return fill ? "square.grid.2x2.fill" : "square.grid.2x2"
		}

		case "download": {
			return fill ? "arrow.down.circle.fill" : "arrow.down.circle"
		}

		case "import": {
			return fill ? "square.and.arrow.down.fill" : "square.and.arrow.down"
		}

		case "info": {
			return fill ? "info.circle.fill" : "info.circle"
		}

		case "move": {
			return fill ? "folder.fill" : "folder"
		}

		case "folder": {
			return fill ? "folder.fill" : "folder"
		}

		case "link": {
			return "link"
		}

		case "reply": {
			return fill ? "arrowshape.turn.up.left.fill" : "arrowshape.turn.up.left"
		}

		case "mute": {
			return fill ? "speaker.slash.fill" : "speaker.slash"
		}

		case "image": {
			return fill ? "photo.fill" : "photo"
		}

		case "play": {
			return fill ? "play.fill" : "play"
		}

		case "pause": {
			return fill ? "pause.fill" : "pause"
		}

		case "cancel": {
			return "xmark"
		}

		case "openExternal": {
			return fill ? "arrow.up.forward.app.fill" : "arrow.up.forward.app"
		}

		case "gear": {
			return fill ? "gearshape.fill" : "gearshape"
		}

		case "listOrdered": {
			return "list.number"
		}

		case "listBullet": {
			return "list.bullet"
		}

		case "minus": {
			return "minus.circle"
		}

		case "scan": {
			return fill ? "doc.viewfinder.fill" : "doc.viewfinder"
		}

		case "upload": {
			return fill ? "arrow.up.circle.fill" : "arrow.up.circle"
		}

		case "envelopeOpen": {
			return fill ? "envelope.open.fill" : "envelope.open"
		}

		case "camera": {
			return fill ? "camera.fill" : "camera"
		}

		case "color": {
			return fill ? "paintpalette.fill" : "paintpalette"
		}

		case "share": {
			return fill ? "square.and.arrow.up.fill" : "square.and.arrow.up"
		}

		case "versions": {
			return fill ? "clock.arrow.circlepath" : "clock.arrow.circlepath"
		}

		case "shield": {
			return fill ? "checkmark.shield.fill" : "checkmark.shield"
		}

		case "doc": {
			return fill ? "doc.fill" : "doc"
		}

		case "calendar": {
			return "calendar"
		}

		case "size": {
			return "ruler"
		}

		case "headerH": {
			return fill ? "textformat.size" : "textformat.size"
		}

		case "checkmark": {
			return fill ? "checkmark" : "checkmark"
		}

		case "queue": {
			return fill ? "text.line.last.and.arrowtriangle.forward" : "text.line.last.and.arrowtriangle.forward"
		}

		case "block": {
			return "nosign"
		}
	}
}
