# Attribution

## IDCT

Freesla is made by [IDCT](https://idct.tech). The IDCT mark in
`assets/default.r/brand/` and `setting/assets.js` is generated from the brand
SVG by `tools/make-icons.js`, recoloured white for the watch's dark interface
and dark for the phone settings screen. It is not covered by the project's
code licence.

## Font Awesome Free

The button artwork in `assets/default.r/btn/` and `assets/default.r/icons/` is
generated from Font Awesome Free icons by `tools/make-icons.js`.

- **Icons** — [Font Awesome Free](https://fontawesome.com), licensed
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
  Copyright Fonticons, Inc.

Icons used: `lock`, `lock-open`, `door-open`, `car-rear`, `car-side`,
`arrow-up`, `arrow-down`, `bolt`, `hand`, `sliders`, `chevron-left`,
`circle-info`, `mug-hot`, and the `github` brand mark.

Font Awesome has no Buy Me a Coffee mark, so the solid `mug-hot` glyph stands in
for it on the support card. The card uses Buy Me a Coffee's own brand yellow
(`#FFDD00`); the name and marks belong to Buy Me a Coffee.

Each is recoloured and composited onto a circular background, and open/close
pairs get an arrow badge; the glyph outlines themselves are unmodified. Run
`node tools/make-icons.js` to regenerate.

## Tesla protocol

The BLE protocol is implemented from Tesla's published
[vehicle-command](https://github.com/teslamotors/vehicle-command) SDK
(Apache 2.0). No Tesla code is included in this project — the implementation is
independent, written against the specification and its test vectors.

Freesla is not affiliated with, endorsed by, or sponsored by Tesla, Inc. Tesla
and the Tesla logo are trademarks of Tesla, Inc.
