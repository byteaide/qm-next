#!/usr/bin/env node

import { Context } from '@qm/cordis'
import { pathToFileURL } from 'node:url'
import Loader from '@qm/cordis-plugin-loader'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@qm/cordis-plugin-include',
  config: {
    path: './cordis.yml',
  },
})
