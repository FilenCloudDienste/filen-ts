import NetInfo from "@react-native-community/netinfo"
import { Buffer } from "buffer"
import { NETINFO_CONFIG } from "@/constants"
import { getRandomValues } from "expo-crypto"

globalThis.crypto = {
	...globalThis.crypto,
	getRandomValues: getRandomValues
}

globalThis.Buffer = Buffer

NetInfo.configure(NETINFO_CONFIG)
