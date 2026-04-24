import "@/lib/polyfills/buffer"
import "@/lib/polyfills/crypto"
import "@/lib/polyfills/DOMException"

import NetInfo from "@react-native-community/netinfo"
import { NETINFO_CONFIG } from "@/constants"
import { enableFreeze } from "react-native-screens"

enableFreeze(true)

NetInfo.configure(NETINFO_CONFIG)
