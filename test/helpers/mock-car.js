// Starting the C# mock car and talking to it over a socket.
//
// The tests that use this skip themselves when it has not been built, because
// it needs a .NET SDK and this repository's test suite must not.

import crypto from 'node:crypto'
import net from 'node:net'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { createClient } from '../../lib/tesla/client.js'
import { localSharedSecret } from '../../lib/tesla/session.js'
import { frameMessage, createReassembler } from '../../lib/tesla/framing.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export function findMockCar () {
  const base = path.join(root, 'mock-car', 'bin')
  if (!fs.existsSync(base)) return null

  const found = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === 'teslamock.exe' || entry.name === 'teslamock') found.push(full)
    }
  }
  walk(base)
  if (found.length === 0) return null
  found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  return found[0]
}

export function randomBytes (n) {
  return new Uint8Array(crypto.randomBytes(n))
}

// Starts the mock, waits until it is listening, and hands back a handle with
// the child, a way to press its keys, and a link the client can be built on.
export function startMockCar (options) {
  const executable = options.executable
  const port = options.port
  const args = [
    '--vin', options.vin,
    '--no-ble',
    '--tcp', String(port),
    '--motion-ms', '0',
    '--quiet'
  ]
  if (options.statePath) args.push('--state', options.statePath)
  else args.push('--no-state')
  if (options.extraArgs) args.push(...options.extraArgs)

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let settled = false
    const output = []

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error('the mock car did not start listening: ' + output.join('')))
    }, 20000)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (text) => {
      output.push(text)
      if (!settled && text.includes('listening on 127.0.0.1:' + port)) {
        settled = true
        clearTimeout(timer)
        resolve(finish(child, port, output))
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text) => output.push(text))
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error('the mock car exited with code ' + code + ': ' + output.join('')))
    })
  })
}

function finish (child, port, output) {
  return {
    child,
    output,

    // The keyboard shortcuts double as a scripting interface, which is how a
    // test reaches the things that need somebody standing at the car.
    press (key) {
      child.stdin.write(key + '\n')
      return new Promise((resolve) => setTimeout(resolve, 250))
    },

    // The same shape the watch's BLE transport gives the client, fragmented the
    // same way a GATT link fragments.
    connect () {
      return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
          const reassembler = createReassembler()
          let handler = null

          socket.on('data', (chunk) => {
            for (const message of reassembler.push(new Uint8Array(chunk))) {
              if (handler) handler(message)
            }
          })
          socket.on('error', () => {})

          resolve({
            socket,
            link: {
              send (message) {
                for (const fragment of frameMessage(message, 20)) socket.write(Buffer.from(fragment))
              },
              onMessage (callback) {
                handler = callback
              }
            }
          })
        })
        socket.on('error', reject)
      })
    },

    async stop () {
      child.stdin.write('q\n')
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000)
        child.on('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
      child.kill()
    }
  }
}

export function buildClient (vin, link, keys, onStatus) {
  return createClient({
    vin,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    link,
    randomBytes,
    deriveSharedSecret: localSharedSecret,
    onStatus
  })
}

export function call (fn) {
  return new Promise((resolve, reject) => {
    fn((err, result) => (err ? reject(err) : resolve(result)))
  })
}
