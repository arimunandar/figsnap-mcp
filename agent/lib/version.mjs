// The package version, read from the one place it is already written down.
//
// Both bins printed a hardcoded '0.1.0' for --version, and /health reported the
// same constant. Bumping package.json to 0.1.1 left all three claiming the old
// number — the sort of drift nobody notices until a bug report names a version
// that was never released. test/e2e-package.mjs now compares them.
//
// createRequire rather than an import attribute: attributes are stable in Node
// 22 but warn on 20, and this package supports 20.

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** @type {string} */
export const VERSION = require('../../package.json').version
