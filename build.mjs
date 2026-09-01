import * as esbuild from 'esbuild'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { watch } from 'node:fs'

const watchMode = process.argv.includes('--watch')
const HTML_TEMPLATE = 'src/ui/index.html'

await mkdir('dist', { recursive: true })

// esbuild leaves the UI bundle in memory; this plugin inlines it into a single
// dist/ui.html, because Figma loads the UI from one self-contained document.
const inlineHtml = {
  name: 'inline-html',
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) return
      const files = result.outputFiles ?? []
      const js = files.find((f) => f.path.endsWith('.js'))?.text ?? ''
      const css = files.find((f) => f.path.endsWith('.css'))?.text ?? ''
      const template = await readFile(HTML_TEMPLATE, 'utf8')
      const html = template
        .replace('<!-- STYLE -->', `<style>\n${css}\n</style>`)
        // Closing tags inside the bundle would end the script element early.
        .replace('<!-- SCRIPT -->', `<script>\n${js.replace(/<\/script/gi, '<\\/script')}\n</script>`)
      await writeFile('dist/ui.html', html)
      console.log('[ui] dist/ui.html')
    })
  },
}

const shared = {
  bundle: true,
  target: 'es2017',
  sourcemap: false,
  logLevel: 'warning',
}

const codeCtx = await esbuild.context({
  ...shared,
  entryPoints: ['src/code.ts'],
  outfile: 'dist/code.js',
})

const uiCtx = await esbuild.context({
  ...shared,
  entryPoints: ['src/ui/main.ts'],
  outdir: 'dist',
  write: false,
  plugins: [inlineHtml],
})

if (watchMode) {
  await codeCtx.watch()
  await uiCtx.watch()
  // The HTML template is not part of esbuild's module graph, so watch it directly.
  watch(HTML_TEMPLATE, () => uiCtx.rebuild().catch(() => {}))
  console.log('watching for changes...')
} else {
  await codeCtx.rebuild()
  await uiCtx.rebuild()
  console.log('[code] dist/code.js')
  await codeCtx.dispose()
  await uiCtx.dispose()
}
