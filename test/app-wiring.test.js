// The one wire everything phone-related hangs off.
//
// ZML's page messaging does not create its own transport. It reads one from
// getApp()._options.globalData.messaging, and that property exists only because
// BaseApp's onCreate puts it there and connects it. Wrap the app in a bare
// App() instead and the property is undefined, so every page throws
//
//   TypeError: cannot read property 'onCall' of undefined
//
// during onInit. The page then carries on building, which is what makes this so
// hard to spot: the screen renders, the app works, and only the phone link is
// gone -- silently, with no failed request to point at, because the request
// machinery was never built. The VIN cannot cross in either direction.
//
// Checked as source text rather than by running it: the device half of ZML is
// bound to the Zepp OS runtime (hmApp, __$$app$$__, @zos/* natives) closely
// enough that loading it under Node proves nothing about the device. This
// guards the composition; the behaviour was verified on the emulator, where the
// watch went from "needs-vin" to "needs-key" once the handshake could complete.

import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const appSource = readFileSync(join(root, 'app.js'), 'utf8')

function pageSources () {
  const pages = join(root, 'page')
  return readdirSync(pages)
    .filter((name) => name.endsWith('.js'))
    .map((name) => ({ name, source: readFileSync(join(pages, name), 'utf8') }))
}

test('the app composes with ZML BaseApp', () => {
  assert.ok(/from ['"]@zeppos\/zml\/base-app['"]/.test(appSource),
    'app.js does not import BaseApp')
  assert.ok(/App\(\s*BaseApp\(/.test(appSource),
    'app.js does not wrap its app object in BaseApp, so no page can reach the phone')
})

test('every page that talks to the phone is backed by that wiring', () => {
  // The dependency runs the other way from how it reads: a page asking for
  // this.request is relying on something app.js did.
  const talkers = pageSources().filter(({ source }) =>
    /this\.request\s*\(/.test(source) || /^\s*onCall\s*\(/m.test(source))

  assert.ok(talkers.length > 0,
    'no page uses the phone link any more -- if that is deliberate, this file can go')

  // Named so a failure says which page would break, rather than just failing.
  assert.ok(/App\(\s*BaseApp\(/.test(appSource),
    'these pages need globalData.messaging: ' + talkers.map((p) => p.name).join(', '))
})

test('the app still exposes the launch entropy sample', () => {
  // Wrapping the app object is exactly the kind of edit that quietly drops a
  // property, and this one is what tools/invert-seed.js reads to decide whether
  // the platform's generator is seeded from the clock.
  assert.ok(/globalData\s*:\s*\{[^}]*launchSample/.test(appSource),
    'launchSample no longer reaches globalData')
  assert.ok(appSource.indexOf('captureLaunchSample()') < appSource.indexOf('App(BaseApp('),
    'the sample must be taken before the app is registered, or it is not the first output')
})
