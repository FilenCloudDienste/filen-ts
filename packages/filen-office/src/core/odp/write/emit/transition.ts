import { refused } from "../../../presentation/model"
import type { OdpEmitFamily } from "../emit"

// Writes the transition family's elements as ODF presentation markup. Not built yet: every emit is refused as
// notImplemented.
export const emitOdpTransition: OdpEmitFamily = {
	emit: () => refused("notImplemented", "odp emit transition")
}
