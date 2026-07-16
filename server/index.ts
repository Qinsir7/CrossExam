import { createCrossExamX402App } from './app'
import { loadX402ServerConfig } from './config'
import { startEmbeddedProcurementRuntime } from './procurementRuntime'

const config = loadX402ServerConfig()
const app = createCrossExamX402App(config)
const stopProcurement = startEmbeddedProcurementRuntime(config)

if (stopProcurement) {
  const stop = () => { void stopProcurement() }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

app.listen(config.port, '0.0.0.0', () => {
  console.log(`CrossExam x402 ASP listening on :${config.port}`)
})
