import type { FlatNamespace, ParseKeys } from "i18next"

// Every key i18n.t accepts, namespaced (its own namespace list).
export type AppKey = ParseKeys<["common", ...Exclude<FlatNamespace, "common">[]]>
