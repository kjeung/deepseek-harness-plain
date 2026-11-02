import { register } from 'node:module'
register('./patch-loader.mjs', import.meta.url)
