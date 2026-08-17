// A stand-in for the watch's BLE stack.
//
// Deliberately strict about the things a real controller is strict about, and
// which nothing here previously checked: it refuses a second write while one is
// still outstanding, refuses to connect while a scan is running, and complains
// if a profile is destroyed while its connection is still open. Each of those
// is a way to crash the Bluetooth stack on real hardware, and each was
// reachable from this codebase.

export function createFakeRadio (settings) {
  const config = settings || {}
  const events = []
  const faults = []

  let scanning = false
  let scanCallback = null
  let connected = false
  let connectCallback = null
  let profileAlive = false
  let writesOutstanding = 0

  let notificationCallback = null
  let writeCompleteCallback = null
  let prepareCallback = null
  // Set by rejectNextWrite(); models a stack refusing a write outright.
  let rejectWrite = false

  const record = (type, detail) => events.push(Object.assign({ type }, detail || {}))
  const fault = (message) => { faults.push(message); record('FAULT', { message }) }

  const radio = {
    events,
    faults,

    // What a real stack would have blown up over.
    get crashed () { return faults.length > 0 },

    mstStartScan (callback, filter) {
      if (scanning) fault('a second scan was started while one was already running')
      scanning = true
      scanCallback = callback
      record('startScan', { filter })
      return config.scanFailsToStart ? false : true
    },

    mstStopScan () {
      if (!scanning) fault('stopped a scan that was not running')
      scanning = false
      record('stopScan')
      return true
    },

    mstConnect (address, callback) {
      if (scanning) fault('connected while the scan was still running')
      connectCallback = callback
      record('connect', { bytes: address ? address.byteLength : 0 })
      return config.connectRejected ? false : true
    },

    mstDisconnect (id) {
      connected = false
      record('disconnect', { id })
      return true
    },

    // This is what allocates, and what starts discovery. The profile becomes
    // live here rather than at a lookup: mstBuildProfile is documented as
    // "creating a Profile connection", it answers a plain boolean, and the
    // pointer it produces is delivered through the prepare callback.
    mstBuildProfile () {
      record('buildProfile')
      if (config.profileFails) return false
      profileAlive = true
      return true
    },

    // Kept because the API has them, and faulted because this app must not use
    // them. Neither appears in Zepp's own easy-ble or in the official
    // master-mode flow; calling mstPrepare on a profile whose discovery
    // mstBuildProfile has already begun is a second discovery on the same
    // profile, and it reset the watch.
    mstGetProfileInstance () {
      fault('called mstGetProfileInstance; the pointer comes from the prepare callback')
      record('getProfile')
      return 7
    },
    mstPrepare () {
      fault('called mstPrepare; mstBuildProfile already started discovery')
      record('prepare')
      return true
    },
    mstOnPrepare (cb) { prepareCallback = cb; return true },
    mstOnCharaNotification (cb) { notificationCallback = cb; return true },
    mstOnCharaWriteComplete (cb) { writeCompleteCallback = cb; return true },

    mstWriteCharacteristic (profile, uuid, data, length) {
      if (rejectWrite) {
        rejectWrite = false
        record('write-rejected')
        return false
      }
      if (writesOutstanding > 0) {
        // The fault this whole exercise is about: fragments pushed back to back
        // with nothing waiting for the controller to drain.
        fault('a write was issued while ' + writesOutstanding + ' was still in flight')
      }
      writesOutstanding++
      // The profile is recorded because addressing the wrong one is silent:
      // the stack is handed a pointer and writes wherever it points.
      record('write', { profile, length, bytes: new Uint8Array(data.slice(0, length)) })
      return true
    },

    mstWriteDescriptor () { record('writeDescriptor'); return true },
    mstOffAllCb () {
      notificationCallback = null
      writeCompleteCallback = null
      prepareCallback = null
      record('offAllCb')
      return true
    },

    mstDestroyProfileInstance () {
      if (connected) fault('destroyed the profile while the connection was still open')
      profileAlive = false
      record('destroyProfile')
      return true
    },

    // --- driving the fake from a test ---

    rejectNextWrite () { rejectWrite = true },

    advertise (name, address, rssi) {
      if (!scanCallback) return
      scanCallback({
        dev_name: name,
        dev_addr: (address || new Uint8Array([1, 2, 3, 4, 5, 6])).buffer,
        rssi: rssi === undefined ? -50 : rssi
      })
    },

    completeConnection () {
      connected = true
      if (connectCallback) connectCallback({ connected: 0, connect_id: 42 })
    },

    dropConnection () {
      connected = false
      if (connectCallback) connectCallback({ connected: 2 })
    },

    // `positional` mimics the published typings, which declare (profile,
    // status); the default mimics what easy-ble reads, a single object. Which
    // one a given watch does is the open question, so both are exercised.
    completePrepare (status) {
      const code = status === undefined ? 0 : status
      if (!prepareCallback) return
      if (config.positional) prepareCallback(7, code)
      else prepareCallback({ status: code, profile: 7 })
    },

    // The controller reporting a fragment has gone out.
    completeWrite (status) {
      const code = status === undefined ? 0 : status
      if (writesOutstanding > 0) writesOutstanding--
      if (!writeCompleteCallback) return
      if (config.positional) writeCompleteCallback(7, 'w', code)
      else writeCompleteCallback({ profile: 7, uuid: 'w', status: code })
    },

    // Takes the object form and delivers it in whichever convention this radio
    // is pretending to be.
    notify (event) {
      if (!notificationCallback) return
      if (config.positional && event && typeof event === 'object') {
        notificationCallback(7, event.uuid, event.data, event.length)
        return
      }
      notificationCallback(event)
    },

    get writesOutstanding () { return writesOutstanding },
    get isScanning () { return scanning },
    get isConnected () { return connected },
    get profileAlive () { return profileAlive },
    writes () { return events.filter((e) => e.type === 'write') },
    types () { return events.map((e) => e.type) }
  }

  return radio
}
