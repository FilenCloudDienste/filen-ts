import { withInfoPlist, type ConfigPlugin } from "@expo/config-plugins"

type OPSQLiteAppGroupOptions = {
	appGroupId: string
}

const withOPSQLiteAppGroup: ConfigPlugin<OPSQLiteAppGroupOptions> = (config, { appGroupId }) => {
	return withInfoPlist(config, config => {
		config.modResults["OPSQLite_AppGroup"] = appGroupId

		return config
	})
}

export default withOPSQLiteAppGroup
