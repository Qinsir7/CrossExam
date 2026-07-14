import { runDemoBenchmark } from '../src/evaluation/demoTruthCases'

console.log(JSON.stringify({ suite: 'demo-only truth regression', ...runDemoBenchmark() }, null, 2))
