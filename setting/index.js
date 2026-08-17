// Phone-side settings.
//
// The VIN is the only thing this app cannot work out for itself, so the screen
// is built around getting that right and then explaining the one-time setup.
// Everything else is either a convenience toggle or an honest statement about
// what the app can and cannot promise.

import { idctLogo, githubMark, freeslaLogo, coffeeMark } from './assets.js'
import { cleanVin } from '../lib/app/vin.js'

const BRAND = '#1f6feb'
const INK = '#1a1a1a'
const MUTED = '#6b7280'
const DANGER = '#c4342b'
const GOOD = '#1a7f37'
const RULE = '#e5e7eb'

// Buy Me a Coffee's own brand yellow, so the card reads as theirs at a glance.
//
// Every constant lives above the AppSettingsPage call on purpose. The framework
// may invoke build() while this module is still evaluating, and a `const`
// declared further down is in the temporal dead zone at that point -- touching
// it throws, and a throw in build() renders the entire page blank with no error
// surfaced anywhere.
const BMC_YELLOW = '#FFDD00'
const BMC_INK = '#292929'

const PAGE = { padding: '0 0 24px 0', backgroundColor: '#f7f7f8' }

// A tinted callout. Used for the things people actually need to notice, rather
// than sprinkled everywhere -- a page where everything is highlighted has
// nothing highlighted.
function tip (tone, title, body) {
  const accent = tone === 'warn' ? '#b45309' : tone === 'danger' ? DANGER : BRAND
  const background = tone === 'warn' ? '#fffbeb' : tone === 'danger' ? '#fef2f2' : '#eff6ff'

  return View({
    style: {
      background,
      borderLeft: '4px solid ' + accent,
      borderRadius: '8px',
      padding: '12px 14px',
      margin: '10px 0'
    }
  }, [
    title
      ? Text({
        style: {
          fontSize: '14px', fontWeight: 'bold', color: accent,
          display: 'block', marginBottom: '4px'
        }
      }, title)
      : null,
    Text({ style: { fontSize: '14px', color: '#374151', lineHeight: '1.45' }, paragraph: true }, body)
  ].filter(Boolean))
}

function card (children) {
  return View({
    style: {
      backgroundColor: '#ffffff',
      border: '1px solid ' + RULE,
      borderRadius: '12px',
      padding: '16px',
      margin: '0 14px 14px 14px'
    }
  }, children)
}

function heading (text) {
  return Text({
    style: {
      fontSize: '13px',
      fontWeight: 'bold',
      color: MUTED,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      margin: '18px 20px 8px 20px'
    }
  }, text)
}

function body (text, colour) {
  return Text({
    style: { fontSize: '14px', color: colour || '#374151', lineHeight: '1.5' },
    paragraph: true
  }, text)
}

// A numbered setup step, so the sequence reads as a sequence.
function step (number, text) {
  return View({ style: { display: 'flex', flexDirection: 'row', margin: '0 0 12px 0' } }, [
    View({
      style: {
        minWidth: '24px', height: '24px', borderRadius: '12px',
        backgroundColor: BRAND, color: '#ffffff',
        fontSize: '13px', fontWeight: 'bold',
        textAlign: 'center', lineHeight: '24px', marginRight: '10px'
      }
    }, String(number)),
    Text({ style: { fontSize: '14px', color: '#374151', lineHeight: '1.5', flex: 1 }, paragraph: true }, text)
  ])
}

AppSettingsPage({
  build (props) {
    const storage = props.settingsStorage
    const vin = readString(storage, 'vin')
    const entropy = readString(storage, 'entropySource')
    const status = readString(storage, 'status')

    return View({ style: PAGE }, [
      masthead(),

      heading('Your Tesla'),
      card([
        TextInput({
          label: 'VIN',
          placeholder: '17 characters, e.g. 5YJ3E1EA7KF000000',
          value: vin,
          onChange: (value) => storage.setItem('vin', JSON.stringify(cleanVin(value)))
        }),
        Text({
          style: {
            fontSize: '13px',
            color: vinTone(vin),
            marginTop: '8px'
          },
          paragraph: true
        }, describeVin(vin)),
        tip('info', 'Where to find it',
          'On the car’s touchscreen under Controls → Software, or on the sticker ' +
          'at the base of the driver’s door pillar. The watch needs it to ' +
          'recognise your car and to sign every command.')
      ]),

      heading('Setting up'),
      card([
        step(1, 'Enter your VIN above.'),
        step(2, 'Open Freesla on your watch. It picks the VIN up from this phone ' +
          'by itself — tap Check phone if it does not appear.'),
        step(3, 'Tap Create key. It takes a few seconds.'),
        step(4, 'Stand next to the car and tap Add to car, then hold an existing ' +
          'key card against the centre console when the car asks.'),
        tip('info', 'Then you are done',
          'The watch works on its own after this — locking and unlocking never ' +
          'involve your phone. You can leave it at home.')
      ]),

      heading('Convenience'),
      card([
        Toggle({
          label: 'Unlock on approach',
          value: storage.getItem('autoUnlock') === 'true',
          onChange: (value) => storage.setItem('autoUnlock', value ? 'true' : 'false')
        }),
        body('With Freesla open on your watch, the car unlocks as you walk up — ' +
          'no button press. It unlocks once per approach and re-arms after the ' +
          'car goes out of range.'),
        tip('warn', 'The app has to be on screen',
          'Zepp OS does not let apps use Bluetooth in the background, so this ' +
          'only works while Freesla is open and the screen is awake. That is a ' +
          'limit of the watch, not something the app can work around.')
      ]),

      heading('Security'),
      card([
        entropyRow(entropy),
        entropyFooter(storage, entropy, readString(storage, 'entropyCheckedAt')),
        body('Your watch has no secure random number generator, and the maths ' +
          'takes it about ninety seconds. So the key is created on this phone ' +
          'and sent to the watch. This happens once, while you tap Create key — ' +
          'never again afterwards.'),
        tip('info', 'Why this matters',
          'The public half of your key is broadcast in the clear every time the ' +
          'watch talks to the car. If the key were guessable, someone could work ' +
          'it out without ever touching your car — so the app refuses to make ' +
          'one it cannot make properly. There is no way to override that.'),
        tip('warn', 'The key crosses once',
          'Your key travels from this phone to the watch a single time, during ' +
          'setup. After that it lives only on the watch. Do the setup somewhere ' +
          'you would be comfortable unlocking the car.'),
        tip('warn', 'Worth turning on',
          'Enable PIN to Drive in your car. It is independent of any key, so even ' +
          'a compromised one gets someone into the cabin but not away with the car.')
      ]),

      heading('Status'),
      card([
        Text({ style: { fontSize: '15px', color: status ? INK : MUTED, display: 'block' } },
          status || 'Not paired yet')
      ]),

      heading('Danger zone'),
      card([
        body('Forgetting the key removes it from this watch and cannot be undone. ' +
          'Remove it from the car separately, on the touchscreen under ' +
          'Controls → Locks.', MUTED),
        Button({
          label: 'Forget this watch’s key',
          style: {
            fontSize: '15px', backgroundColor: DANGER, color: '#ffffff',
            borderRadius: '8px', marginTop: '10px'
          },
          onClick: () => storage.setItem('forgetKey', JSON.stringify(Date.now()))
        })
      ]),

      supportCard(),
      colophon()
    ])
  }
})

function masthead () {
  return View({
    style: {
      backgroundColor: '#ffffff',
      borderBottom: '1px solid ' + RULE,
      padding: '22px 20px 18px 20px',
      textAlign: 'center'
    }
  }, [
    // Text is inline in this framework, so each line needs display:block or
    // they run together on one row.
    freeslaLogo
      ? Image({
        src: freeslaLogo,
        style: { width: '56px', height: 'auto', display: 'block', margin: '0 auto 12px auto' }
      })
      : null,
    // textAlign on the wrapper does not reach block children here, so each line
    // centres itself.
    Text({
      style: {
        fontSize: '26px', fontWeight: 'bold', color: INK,
        display: 'block', textAlign: 'center'
      }
    }, 'Freesla'),
    Text({
      style: {
        fontSize: '14px', color: MUTED,
        display: 'block', textAlign: 'center', marginTop: '4px'
      }
    }, 'A Bluetooth key for your Tesla, on your wrist'),
    Text({
      style: {
        fontSize: '12px', color: MUTED,
        display: 'block', textAlign: 'center', marginTop: '10px'
      }
    }, 'Not affiliated with or endorsed by Tesla, Inc.')
  ].filter(Boolean))
}

function entropyRow (source) {
  const known = source && source !== 'none'
  const missing = source === 'none'

  const label = missing
    ? 'This phone has no secure random source'
    : known
      ? 'This phone can create a secure key'
      // Not "checking": nothing is in progress. The companion service simply
      // has not reported, which usually means it has not started yet.
      : 'Not checked yet — open Freesla on your watch once'

  return View({
    style: {
      display: 'flex', flexDirection: 'row', alignItems: 'center',
      backgroundColor: missing ? '#fef2f2' : known ? '#f0fdf4' : '#f3f4f6',
      borderRadius: '8px', padding: '10px 12px', marginBottom: '10px'
    }
  }, [
    Text({
      style: {
        fontSize: '18px', marginRight: '10px',
        color: missing ? DANGER : known ? GOOD : MUTED
      }
    }, missing ? '✕' : known ? '✓' : '…'),
    Text({
      style: {
        fontSize: '14px', fontWeight: 'bold',
        color: missing ? DANGER : known ? GOOD : MUTED
      }
    }, label)
  ])
}

// The check itself runs in the companion service, not on this screen, so this
// row can only report what that service last wrote. Nothing refreshes on its
// own, hence the button.
function entropyFooter (storage, entropy, checkedAt) {
  const pending = !entropy

  return View({
    style: {
      display: 'flex', flexDirection: 'row', alignItems: 'center',
      justifyContent: 'space-between', marginBottom: '12px'
    }
  }, [
    Text({ style: { fontSize: '12px', color: MUTED, flex: 1 } },
      pending
        ? 'The phone helper has not reported yet.'
        : 'Last checked ' + describeWhen(checkedAt)),
    Button({
      label: 'Check again',
      style: {
        fontSize: '13px', backgroundColor: '#eef2f7', color: BRAND,
        borderRadius: '8px', padding: '6px 12px', marginLeft: '10px'
      },
      // The service watches this key and answers by rewriting entropySource.
      onClick: () => storage.setItem('entropyProbeRequest', JSON.stringify(Date.now()))
    })
  ])
}

function describeWhen (stamp) {
  const when = Number(stamp)
  if (!when) return 'just now'

  const seconds = Math.max(0, Math.round((Date.now() - when) / 1000))
  if (seconds < 45) return 'just now'
  if (seconds < 3600) return Math.round(seconds / 60) + ' min ago'
  if (seconds < 86400) return Math.round(seconds / 3600) + ' h ago'
  return Math.round(seconds / 86400) + ' d ago'
}

function supportCard () {
  return View({
    style: {
      backgroundColor: '#fffdf0',
      border: '2px solid ' + BMC_YELLOW,
      borderRadius: '14px',
      padding: '16px',
      margin: '0 14px 20px 14px'
    }
  }, [
    Text({
      style: {
        fontSize: '14px', color: '#374151', lineHeight: '1.5',
        display: 'block', textAlign: 'center'
      },
      paragraph: true
    }, 'Freesla is free and open source — if you like it, please support the development.'),

    // Styled as Buy Me a Coffee's own button: their yellow, dark text, rounded.
    //
    // The icon sits beside the Link rather than inside it. Link only takes a
    // text child here; nesting components in it blanks the whole page.
    View({
      style: {
        display: 'flex', flexDirection: 'row',
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: BMC_YELLOW,
        borderRadius: '10px', padding: '11px 16px', marginTop: '14px'
      }
    }, [
      coffeeMark
        ? Image({ src: coffeeMark, style: { width: '20px', height: '18px', marginRight: '9px' } })
        : null,
      Link({
        source: 'https://buymeacoffee.com/idct',
        style: {
          fontSize: '15px', fontWeight: 'bold',
          color: BMC_INK, textDecoration: 'none'
        }
      }, 'Buy me a coffee')
    ].filter(Boolean))
  ])
}

function colophon () {
  return View({ style: { padding: '10px 20px 0 20px', textAlign: 'center' } }, [
    idctLogo
      ? Image({ src: idctLogo, style: { width: '66px', margin: '0 auto 10px auto', display: 'block' } })
      : null,

    Text({
      style: { fontSize: '14px', color: MUTED, display: 'block', textAlign: 'center' }
    }, 'Made by IDCT'),
    Link({
      source: 'https://idct.tech',
      style: { fontSize: '14px', color: BRAND, display: 'block', marginTop: '2px' }
    }, 'idct.tech'),

    View({
      style: {
        display: 'flex', flexDirection: 'row', justifyContent: 'center',
        alignItems: 'center', marginTop: '14px'
      }
    }, [
      githubMark
        ? Image({ src: githubMark, style: { width: '18px', height: '18px', marginRight: '8px' } })
        : null,
      Link({
        source: 'https://github.com/ideaconnect/freesla',
        style: { fontSize: '14px', color: BRAND }
      }, 'Open source on GitHub')
    ].filter(Boolean)),

    Text({
      style: { fontSize: '12px', color: MUTED, marginTop: '12px', lineHeight: '1.5' },
      paragraph: true
    }, 'Free and open source. Built against Tesla’s published vehicle-command ' +
       'protocol; no Tesla code is included. Icons by Font Awesome (CC BY 4.0).')
  ].filter(Boolean))
}

function readString (storage, key) {
  const raw = storage.getItem(key)
  if (!raw) return ''
  try {
    return JSON.parse(raw) || ''
  } catch (e) {
    return ''
  }
}

// VINs never contain I, O or Q, so those are always a misread 1 or 0.
function describeVin (vin) {
  if (!vin) return 'Required. The watch cannot find your car without it.'
  if (/[IOQ]/.test(vin)) return 'A VIN never contains I, O or Q — check for 1 and 0.'
  if (vin.length !== 17) return 'A VIN is 17 characters; this one has ' + vin.length + '.'
  return 'Looks right. Continue on the watch.'
}

function vinTone (vin) {
  if (!vin) return MUTED
  return vin.length === 17 && !/[IOQ]/.test(vin) ? GOOD : DANGER
}
