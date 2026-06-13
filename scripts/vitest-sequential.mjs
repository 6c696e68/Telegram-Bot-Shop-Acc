import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const testFilePattern = /\.(test|spec)\.ts$/
const roots = ['test', 'src']
const cliArgs = process.argv.slice(2)
const explicitFiles = cliArgs.filter((arg) => testFilePattern.test(arg))
const extraArgs = cliArgs.filter((arg) => !explicitFiles.includes(arg))
const batchSize = Math.max(1, Number.parseInt(process.env.VITEST_BATCH_SIZE || '1', 10) || 1)
const vitestBin = join(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'vitest.cmd' : 'vitest',
)

function collectTestFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const absolutePath = join(dir, entry.name)

    if (entry.isDirectory()) {
      files.push(...collectTestFiles(absolutePath))
      continue
    }

    if (entry.isFile() && testFilePattern.test(entry.name)) {
      files.push(relative(process.cwd(), absolutePath))
    }
  }

  return files
}

function chunk(items, size) {
  const chunks = []

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }

  return chunks
}

const discoveredFiles = roots
  .filter((root) => {
    try {
      return statSync(root).isDirectory()
    } catch {
      return false
    }
  })
  .flatMap((root) => collectTestFiles(root))
  .sort()

const testFiles = explicitFiles.length > 0 ? explicitFiles : discoveredFiles

if (testFiles.length === 0) {
  console.error('[vitest] No test files found.')
  process.exit(1)
}

const batches = chunk(testFiles, batchSize)

for (const [index, batch] of batches.entries()) {
  console.log(`[vitest] Batch ${index + 1}/${batches.length}: ${batch.join(', ')}`)

  const result = spawnSync(vitestBin, ['run', ...extraArgs, ...batch], {
    env: process.env,
    stdio: 'inherit',
  })

  if (result.error) {
    console.error(`[vitest] Failed to start Vitest: ${result.error.message}`)
    process.exit(1)
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

console.log(`[vitest] Completed ${testFiles.length} test files.`)
