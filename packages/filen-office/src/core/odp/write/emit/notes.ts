import { refused } from "../../../presentation/model"
import type { OdpEmitFamily } from "../emit"

// Writes the notes family's elements as ODF presentation markup. Not built yet: every emit is refused as
// notImplemented.
export const emitOdpNotes: OdpEmitFamily = {
	emit: () => refused("notImplemented", "odp emit notes")
}
