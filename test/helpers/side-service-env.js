// Runs the real companion service against stubbed Zepp OS globals.
//
// The service is a handful of lines of logic wrapped around ZML's lifecycle,
// and every bug it has had so far has been in the wrapping rather than the
// logic: a handler attached to a hook that does not fire in the case that
// matters. Testing the logic alone would have caught none of them, so this
// loads app-side/index.js unmodified and lets ZML dispatch to it exactly as the
// phone does.

import { normaliseVin } from '../../lib/app/vin.js'

// Loaded exactly once per process, and deliberately so.
//
// ZML's BaseSideService appends its mixins to an array shared by the function
// itself, so calling it a second time leaves every mixin registered twice, a
// third time three times, and so on. Re-importing the service per test would
// stack duplicate settings listeners and make each test see one more copy of
// every message than the last. The service object is reused instead and its
// lifecycle re-run against fresh globals, which is also closer to the phone:
// there, one service is started and stopped repeatedly.
let loaded = null

function createSettingsStorage (initial) {
  const items = new Map()
  for (const [key, value] of Object.entries(initial || {})) items.set(key, value)
  const listeners = []

  return {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem (key, value) {
      items.set(key, value)
      // The real storage notifies on write, including writes made by the
      // service itself. Anything that reacts to a change has to cope with
      // hearing about its own.
      for (const listener of listeners.slice()) listener({ key, newValue: value })
    },
    removeItem: (key) => items.delete(key),
    clear: () => items.clear(),
    toObject: () => Object.fromEntries(items),
    addListener (event, handler) {
      if (event === 'change') listeners.push(handler)
    },
    removeListener () { listeners.length = 0 },
    listenerCount: () => listeners.length
  }
}

// `launch.settingsChanged` models the service being started *by* a settings
// edit, which is how it starts nearly every time in practice. ZML then replays
// the change through onSettingsChange rather than through the change listener,
// because the listener could not have existed when it happened.
export async function startSideService (options) {
  const config = options || {}
  const storage = createSettingsStorage(config.settings)
  const calls = []
  const logs = []

  const saved = {}
  const globals = {
    settings: { settingsStorage: storage },
    sideService: {
      launchReasons: {
        settingsChanged: !!config.launchedBySettingsChange,
        fileTransfer: false
      },
      launchArgs: config.launchArgs || null,
      appInfo: { app: { appName: 'Freesla' } }
    },
    Logger: {
      getLogger: () => ({
        log: (...args) => logs.push(args.join(' ')),
        error: (...args) => logs.push('ERROR ' + args.join(' ')),
        warn: () => {},
        debug: () => {}
      })
    },
    messaging: { peerSocket: { addListener () {}, send () {}, readyState: 1 } },
    transferFile: {
      onFile () {},
      inbox: { on () {}, off () {}, getNextFile: () => null },
      outbox: { on () {}, off () {}, enqueueFile () {} }
    },
    image: { convert: (x) => x },
    network: {},
    getApp: () => ({ port2: { onMessage () {}, postMessage () {} } }),
    AppSideService: (service) => { globals.__service = service }
  }

  for (const key of Object.keys(globals)) {
    saved[key] = globalThis[key]
    globalThis[key] = globals[key]
  }

  if (!loaded) {
    await import('../../app-side/index.js')
    loaded = globals.__service
  }
  const service = loaded

  // The messaging layer is stubbed, so record what the service tries to push
  // instead of pretending there is a watch on the other end.
  service.call = (message) => { calls.push(message) }

  // Registers this run's settings listener against the globals just installed.
  // Not paired with onDestroy: ZML's teardown clears listeners from whichever
  // storage is global at the time, which by then belongs to the next test.
  service.onInit()
  // ZML replays the launch-time settings change a tick later, so anything
  // asserting on it has to let that tick happen.
  await new Promise((resolve) => setTimeout(resolve, 20))

  return {
    service,
    storage,
    calls,
    logs,
    // Drives a settings edit the way the phone does, for a service that is
    // already running.
    changeSetting (key, value) {
      storage.setItem(key, value)
    },
    // Answers a watch-side request and hands back what the watch would see.
    request (payload) {
      return new Promise((resolve, reject) => {
        service.onRequest(payload, (err, data) => (err ? reject(err) : resolve(data)))
      })
    },
    restore () {
      for (const key of Object.keys(saved)) {
        if (saved[key] === undefined) delete globalThis[key]
        else globalThis[key] = saved[key]
      }
    }
  }
}

// The phone stores whatever has been typed so far, so a VIN mid-entry is a
// normal state rather than a corrupt one.
export function storedVin (value) {
  return JSON.stringify(value)
}

export function isCompleteVin (value) {
  return normaliseVin(value) !== null
}
