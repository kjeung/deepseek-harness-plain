import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const TARGET = '/@deepseek-ai/dsh-client-connection/lib/index.js'
const NEEDLE = 'return this.authenticate(request, secure)?.version === COOKIE_PAYLOAD_VERSION;'
const PATCHED = 'if (process.env.ONEPANEL_DSH_AUTH_PROXY === "1") return true;\n\t\t' + NEEDLE

export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith(TARGET)) {
    const source = await readFile(fileURLToPath(url), 'utf8')
    if (source.includes(NEEDLE) && !source.includes(PATCHED)) {
      console.log('[patch-loader] applied ONEPANEL_DSH_AUTH_PROXY auth bypass')
      return { format: 'module', source: source.replace(NEEDLE, PATCHED), shortCircuit: true }
    }
  }
  return nextLoad(url, context)
}
