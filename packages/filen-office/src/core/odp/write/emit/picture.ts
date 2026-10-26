import { refused } from "../../../presentation/model"
import type { OdpEmitFamily } from "../emit"

// Writes the picture family's elements as ODF presentation markup. Not built yet: every emit is refused as
// notImplemented.
export const emitOdpPicture: OdpEmitFamily = {
	emit: () => refused("notImplemented", "odp emit picture")
}
