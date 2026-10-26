import { refused } from "../../../presentation/model"
import type { OdpEmitFamily } from "../emit"

// Writes the table family's elements as ODF presentation markup. Not built yet: every emit is refused as
// notImplemented.
export const emitOdpTable: OdpEmitFamily = {
	emit: () => refused("notImplemented", "odp emit table")
}
