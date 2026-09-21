import striptags from "striptags"

export function createNotePreviewFromContentText(type: "rich" | "checklist" | "other", content?: string): string {
	try {
		if (!content || content.length === 0) {
			return ""
		}

		if (type === "rich") {
			if (content.indexOf("<p><br></p>") === -1) {
				return striptags(content.split("\n")[0] ?? "").slice(0, 128)
			}

			return striptags(content.split("<p><br></p>")[0] ?? "").slice(0, 128)
		}

		if (type === "checklist") {
			const ex = content
				// eslint-disable-next-line quotes
				.replaceAll('<ul data-checked="false">', "")
				// eslint-disable-next-line quotes
				.replaceAll('<ul data-checked="true">', "")
				.replaceAll("\n", "")
				.split("<li>")

			for (const listPoint of ex) {
				const listPointEx = listPoint.split("</li>")

				if (!listPointEx[0]) {
					continue
				}

				if (listPointEx[0].trim().length > 0) {
					return striptags(listPointEx[0].trim()).slice(0, 128)
				}
			}

			return ""
		}

		return striptags(content.split("\n")[0] ?? "").slice(0, 128)
	} catch {
		return ""
	}
}
