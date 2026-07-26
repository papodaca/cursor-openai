import { AuthSession } from "./src/auth-session.ts"
import { HelpRequested, loadConfig, parseArgs, usage } from "./src/config.ts"
import { startServer } from "./src/server.ts"

async function main() {
  let cli
  try {
    cli = parseArgs(process.argv.slice(2))
  } catch (err) {
    if (err instanceof HelpRequested) {
      console.log(usage())
      process.exit(0)
    }
    console.error(err instanceof Error ? err.message : err)
    console.error()
    console.error(usage())
    process.exit(1)
  }

  const config = loadConfig(cli)
  const auth = await AuthSession.load(config.authPath, config.apiBaseURL)
  const server = startServer(config, auth)

  const shutdown = () => {
    auth.stop()
    server.stop()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
