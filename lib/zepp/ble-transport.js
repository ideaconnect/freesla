// Platform binding for Bluetooth.
//
// All the logic lives in ble-session.js so it can be driven against a fake
// radio off-device; this only supplies the real one. The same arrangement as
// storage.js over settings-store.js.

import {
  mstStartScan, mstStopScan, mstConnect, mstDisconnect,
  mstBuildProfile, mstGetProfileInstance, mstPrepare, mstOnPrepare,
  mstOnCharaNotification, mstWriteCharacteristic, mstWriteDescriptor,
  mstOnCharaWriteComplete, mstOffAllCb, mstDestroyProfileInstance
} from '@zos/ble'

import { createBleSession } from './ble-session.js'

export { STATE } from './ble-states.js'

const RADIO = {
  mstStartScan,
  mstStopScan,
  mstConnect,
  mstDisconnect,
  mstBuildProfile,
  mstGetProfileInstance,
  mstPrepare,
  mstOnPrepare,
  mstOnCharaNotification,
  mstWriteCharacteristic,
  mstWriteDescriptor,
  mstOnCharaWriteComplete,
  mstOffAllCb,
  mstDestroyProfileInstance
}

export function createBleTransport (options) {
  return createBleSession(RADIO, options)
}
