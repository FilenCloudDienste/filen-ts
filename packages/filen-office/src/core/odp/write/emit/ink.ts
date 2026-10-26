import { refused } from "../../../presentation/model"
import type { OdpEmitFamily } from "../emit"

// Writes the ink family's elements as ODF presentation markup. Not built yet: every emit is refused as
// notImplemented.
export const emitOdpInk: OdpEmitFamily = {
	emit: () => refused("notImplemented", "odp emit ink")
}
