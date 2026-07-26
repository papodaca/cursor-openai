import { loadConfig } from "./src/config.ts"
import { startServer } from "./src/server.ts"

const config = loadConfig()
startServer(config)
