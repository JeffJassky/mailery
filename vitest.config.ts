import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig({
  define: { __PKG_VERSION__: JSON.stringify(pkg.version) },
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // Loads .env for the live tiers. No-op when the file is absent.
    setupFiles: ['test/setup-env.ts'],

    // Every `createTestMailer()` starts a real `mongod` and then builds the
    // schema on it, and the suite calls it about fifty times across forty
    // files. Left to itself vitest fans out to one worker per core, which put
    // 20–26 `mongod` processes on the machine at once — and the expensive part
    // is not starting them, it is `Mailer.init` creating indexes against them.
    // Measured, one harness at a time: ~1.9s. Ten at a time: ~8.5s, of which
    // 7.3s is index creation. That is the whole flake. The default 5s test
    // budget is smaller than the setup cost under load, so whichever file
    // happened to be building a harness when the machine was busiest failed —
    // a different one each run, every one of them green on its own.
    //
    // Two things follow, and both are needed.
    //
    // `maxWorkers` caps the fan-out. Four rather than one: the suite is
    // waiting on mongod far more than it is computing, so the parallelism is
    // nearly free — 4 workers costs ~30% of wall clock against ~2.5x fewer
    // concurrent servers. Serialising it entirely would trade a 60s suite for
    // an 8-minute one to buy headroom nothing needs.
    //
    // The timeouts then stop a slow-but-correct setup from being reported as a
    // failing test. They are a budget, not an assertion: no test relies on
    // timing out, so the only thing a tighter one buys is a false negative on
    // a loaded CI runner.
    pool: 'forks',
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts'],
    },
  },
})
