import { defineConfig } from 'tsup'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig({
  define: { __PKG_VERSION__: JSON.stringify(pkg.version) },
  entry: {
    index: 'src/server/index.ts',
    testing: 'src/testing/index.ts',
    cli: 'src/cli/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: { entry: { index: 'src/server/index.ts', testing: 'src/testing/index.ts' } },
  sourcemap: true,
  clean: true,
  target: 'node20',
  outExtension: ({ format }) => ({
    js: format === 'cjs' ? '.cjs' : '.js',
  }),
  splitting: false,
  treeshake: true,
})
