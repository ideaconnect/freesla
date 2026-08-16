// Stubs the component factories that the Zepp settings framework injects as
// globals, so setting/index.js can be rendered under Node.
//
// The globals are installed as a side effect of importing this module, and
// ES modules evaluate in source order — so a test imports this first and
// setting/index.js second, and the page finds its globals already in place.
// That avoids a dynamic import, which the Zepp bundler cannot compile: it walks
// the whole project including test/, targeting ES2015, where top-level await is
// a syntax error.

let captured = null

function node (type) {
  // The framework calls these as component(props) or component(props, children).
  return function (props, children) {
    return { type, props: props || {}, children: normalise(children) }
  }
}

function normalise (children) {
  if (children === undefined || children === null) return []
  if (Array.isArray(children)) return children
  return [children]
}

globalThis.View = node('View')
globalThis.Text = node('Text')
globalThis.Image = node('Image')
globalThis.Link = node('Link')
globalThis.Button = node('Button')
globalThis.Toggle = node('Toggle')
globalThis.TextInput = node('TextInput')
globalThis.Select = node('Select')
globalThis.Slider = node('Slider')
globalThis.Section = node('Section')
// Renders once, immediately, exactly as the real framework appears to.
//
// This matters more than it looks: building eagerly means the page is rendered
// while its own module is still evaluating, so anything declared BELOW the
// AppSettingsPage call is still in the temporal dead zone. A `const` colour
// defined further down the file throws a ReferenceError here and blanks the
// whole screen on a phone, with no error reported. Deferring the first build
// would hide that entire class of bug.
let eagerError = null

globalThis.AppSettingsPage = function (definition) {
  captured = definition
  try {
    definition.build({ settingsStorage: fakeStorage({}) })
  } catch (error) {
    eagerError = error
  }
}

export function getEagerError () {
  return eagerError
}

export function getPage () {
  return captured
}

// Stands in for props.settingsStorage, exposing the raw store for assertions.
export function fakeStorage (initial) {
  const store = Object.assign({}, initial)
  return {
    getItem (key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : undefined },
    setItem (key, value) { store[key] = value },
    removeItem (key) { delete store[key] },
    store
  }
}

export function walk (root, visit) {
  if (!root || typeof root !== 'object') return
  visit(root)
  for (const child of root.children || []) walk(child, visit)
}

export function collect (root, predicate) {
  const found = []
  walk(root, (n) => { if (predicate(n)) found.push(n) })
  return found
}

export function allText (root) {
  let out = ''
  walk(root, (n) => {
    for (const child of n.children || []) {
      if (typeof child === 'string') out += child + ' '
    }
  })
  return out
}
