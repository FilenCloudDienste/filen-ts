import { PresentationError } from "../../../core/presentation/model"
import type { MediaCapability } from "../engine"
import { mediaServing, registerMedia, sessionClosed } from "../media"

// media(part, port): the medium's bytes served on the page's port by the host's MediaPortServer (web: a range port the
// service worker streams from), or why not. registerMedia(source): a medium to insert, read once (dom/presentation/
// media.ts holds the rules).
export const mediaCapability: MediaCapability = {
	async media(context, part, port) {
		const server = context.session.services.media

		if (server === undefined) throw new PresentationError("notImplemented", "media")

		const serving = await mediaServing(context.session, part)

		if (serving.kind === "refused") {
			port.close()

			return serving
		}

		server.serve(port, serving.read, sessionClosed(context.session))

		return serving.meta
	},
	registerMedia: (context, source) => registerMedia(context.session, source, context.slicing, context.signal)
}
