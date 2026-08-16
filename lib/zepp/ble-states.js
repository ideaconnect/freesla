// Connection states, kept apart from the transport itself so that code
// reasoning about them does not have to import @zos/ble. That keeps the
// controller testable off-device, which matters because it decides when a car
// gets unlocked without anyone pressing anything.

export const STATE = {
  IDLE: 'idle',
  SCANNING: 'scanning',
  CONNECTING: 'connecting',
  PREPARING: 'preparing',
  READY: 'ready',
  FAILED: 'failed'
}
