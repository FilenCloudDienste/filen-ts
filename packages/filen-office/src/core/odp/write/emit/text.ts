import { refused } from "../../../presentation/model"
import type { OdpEmitFamily } from "../emit"

// Writes the text family's elements as ODF presentation markup. Not built yet: every emit is refused as
// notImplemented.
export const emitOdpText: OdpEmitFamily = {
	emit: () => refused("notImplemented", "odp emit text")
}
