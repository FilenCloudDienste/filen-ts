import { refused } from "../../../presentation/model"
import type { OdpEmitFamily } from "../emit"

// Writes the design family's elements as ODF presentation markup. Not built yet: every emit is refused as
// notImplemented.
export const emitOdpDesign: OdpEmitFamily = {
	emit: () => refused("notImplemented", "odp emit design")
}
