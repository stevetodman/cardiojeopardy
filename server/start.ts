import process from 'node:process'
import { startGameServer } from './gameServer'

async function main(): Promise<void> {
  const server = await startGameServer({ dev: false })
  const shutdown = async () => {
    await server.close()
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
}

void main().catch((error) => {
  console.error('[quiz-board] failed to start', error)
  process.exit(1)
})
