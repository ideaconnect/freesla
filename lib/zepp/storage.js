// Platform binding for persistence.
//
// LocalStorage survives restarts and is cleared on uninstall, which is the
// right lifetime for a car key: removing the app destroys the key material,
// and the enrolled copy can then be revoked from the Tesla app.
//
// All logic lives in lib/app/settings-store.js so it can be tested off-device;
// this only supplies the backend.

import { LocalStorage } from '@zos/storage'
import { createSettingsStore } from '../app/settings-store.js'

export function createStorage () {
  const local = new LocalStorage()

  return createSettingsStore({
    getItem (key, fallback) { return local.getItem(key, fallback) },
    setItem (key, value) { local.setItem(key, value) },
    removeItem (key) { local.removeItem(key) },
    clear () { local.clear() }
  })
}
