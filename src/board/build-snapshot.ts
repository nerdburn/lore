// Run in a child process so a large YAML history cannot block the web server.
import { execFileSync } from 'node:child_process'
import { parseWorkItems, summarizeForRecall } from '../work.js'

try {
  const [repo, oid] = process.argv.slice(2)
  const raw = execFileSync('git', ['-C', repo, 'cat-file', 'blob', oid], { maxBuffer: 64 * 1024 * 1024 })
  process.stdout.write(JSON.stringify(parseWorkItems(raw.toString()).map(summarizeForRecall)))
} catch {
  process.stderr.write('Could not build the board snapshot from the tracker.\n')
  process.exitCode = 1
}
