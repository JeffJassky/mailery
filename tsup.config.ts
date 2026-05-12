import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/server/index.ts',
    testing: 'src/testing/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  outExtension: ({ format }) => ({
    js: format === 'cjs' ? '.cjs' : '.js',
  }),
  splitting: false,
  treeshake: true,
})
