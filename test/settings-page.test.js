// Renders the phone settings page in Node against stubbed framework globals.
//
// The settings page had no coverage at all, and it shows: a change that made
// `Link` hold component children blanked the entire screen, and the only signal
// was an empty <div id="app"> in a simulator window. A crash here takes the VIN
// field with it, which is the one thing setup cannot proceed without.
//
// The stubs mimic the component factories the Zepp settings framework injects as
// globals. They record what was built so the tree can be asserted on.

import { test } from 'node:test'
import assert from 'node:assert'

import { getPage, getEagerError, fakeStorage, collect, allText } from './helpers/settings-env.js'
// Imported second on purpose: the helper installs the framework globals that
// this module needs at evaluation time.
import '../setting/index.js'

function render (initial) {
  return getPage().build({ settingsStorage: fakeStorage(initial) })
}


test('the settings page defines a build function', () => {
  assert.ok(getPage(), 'AppSettingsPage was never called')
  assert.strictEqual(typeof getPage().build, 'function')
})

test('it renders while its own module is still evaluating', () => {
  // The framework builds the page eagerly, so anything declared below the
  // AppSettingsPage call is still in the temporal dead zone. Reaching for one
  // throws and blanks the entire screen, silently.
  assert.strictEqual(getEagerError(), null,
    'building during module evaluation threw: ' + (getEagerError() && getEagerError().message))
})

test('it renders without throwing, on a blank install', () => {
  // The state a first-time user actually sees: nothing configured at all.
  const tree = render({})
  assert.ok(tree, 'build returned nothing')
  assert.strictEqual(tree.type, 'View')
  assert.ok((tree.children || []).length > 0, 'page rendered empty')
})

test('it renders with every setting populated', () => {
  const tree = render({
    vin: JSON.stringify('5YJ30123456789ABC'),
    autoUnlock: 'true',
    entropySource: JSON.stringify('getRandomValues'),
    entropyCheckedAt: JSON.stringify(Date.now()),
    status: JSON.stringify('Paired')
  })
  assert.ok(allText(tree).indexOf('secure key') >= 0, 'entropy state not reported')
})

test('the VIN field is present and writes back normalised', () => {
  const storage = fakeStorage({})
  const tree = getPage().build({ settingsStorage: storage })

  const inputs = collect(tree, (n) => n.type === 'TextInput')
  assert.strictEqual(inputs.length, 1, 'expected exactly one text input')

  inputs[0].props.onChange(' 5yj3-0123 4567 89abc ')
  assert.strictEqual(JSON.parse(storage.store.vin), '5YJ30123456789ABC')
})

test('Link is only ever given a plain string', () => {
  // Passing components as Link children blanks the whole page, and nothing in
  // the framework complains, it just renders nothing.
  const tree = render({})
  const links = collect(tree, (n) => n.type === 'Link')
  assert.ok(links.length >= 2, 'expected the idct and github links')

  for (const link of links) {
    assert.ok(link.props.source, 'a link has no destination')
    for (const child of link.children) {
      assert.strictEqual(typeof child, 'string',
        'Link child must be a string, got ' + (child && child.type))
    }
  }
})

test('the support card is present and points at Buy Me a Coffee', () => {
  const tree = render({})
  const links = collect(tree, (n) => n.type === 'Link')
  const coffee = links.find((l) => String(l.props.source).indexOf('buymeacoffee.com') >= 0)

  assert.ok(coffee, 'no Buy Me a Coffee link')
  assert.strictEqual(coffee.props.source, 'https://buymeacoffee.com/idct')

  const text = allText(tree)
  assert.ok(text.indexOf('free and open source') >= 0, 'support wording missing')
  assert.ok(text.indexOf('Buy me a coffee') >= 0, 'call to action missing')
})

test('the support card uses the Buy Me a Coffee yellow', () => {
  const tree = render({})
  const yellow = collect(tree, (n) => {
    const style = n.props.style || {}
    return String(style.border || '').toUpperCase().indexOf('#FFDD00') >= 0
  })
  assert.ok(yellow.length >= 1, 'no yellow-bordered card')
  assert.ok(String(yellow[0].props.style.borderRadius).length > 0, 'card is not rounded')
})

test('both brand marks and the attribution links are present', () => {
  const tree = render({})
  const images = collect(tree, (n) => n.type === 'Image')
  assert.ok(images.length >= 3, 'expected freesla, idct and github marks')

  for (const image of images) {
    assert.ok(String(image.props.src).startsWith('data:image/png;base64,'),
      'settings images must be inlined, not file paths')
  }

  const sources = collect(tree, (n) => n.type === 'Link').map((l) => l.props.source)
  assert.ok(sources.indexOf('https://idct.tech') >= 0, 'idct.tech link missing')
  assert.ok(sources.some((s) => s.indexOf('github.com/ideaconnect/freesla') >= 0),
    'github link missing')
})

test('stacked text is block-level so lines cannot run together', () => {
  // Text is inline by default here; without display:block the masthead lines
  // render side by side on one row.
  const tree = render({})
  const masthead = collect(tree, (n) =>
    (n.children || []).some((c) => c && c.children && c.children[0] === 'Freesla'))[0]

  assert.ok(masthead, 'masthead not found')
  const lines = (masthead.children || []).filter((c) => c && c.type === 'Text')
  assert.ok(lines.length >= 3, 'expected three masthead lines')
  for (const line of lines) {
    assert.strictEqual(line.props.style.display, 'block',
      'masthead line is inline and will collide with its neighbour')
  }
})

test('the refresh control asks the companion service to re-probe', () => {
  const storage = fakeStorage({})
  const tree = getPage().build({ settingsStorage: storage })

  const buttons = collect(tree, (n) => n.type === 'Button')
  const refresh = buttons.find((b) => String(b.props.label).indexOf('Check again') >= 0)
  assert.ok(refresh, 'no refresh button')

  refresh.props.onClick()
  assert.ok(storage.store.entropyProbeRequest, 'refresh wrote no probe request')
})
