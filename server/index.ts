import { createCrossExamX402App } from './app'
import { loadX402ServerConfig } from './config'

const config = loadX402ServerConfig()
const app = createCrossExamX402App(config)

app.listen(config.port, '0.0.0.0', () => {
  console.log(`CrossExam x402 ASP listening on :${config.port}`)
})
