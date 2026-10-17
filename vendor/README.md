# Pinned browser dependencies

These files are unmodified browser distributions from the npm packages below,
downloaded with npm's normal registry integrity verification. They are served
locally so no remote script is loaded until the user requests speech models.
Model weights and the ONNX WebAssembly runtime remain on-demand downloads.

| File | Upstream package | License |
| --- | --- | --- |
| `kokoro.web.js` | `kokoro-js@1.2.1`, `dist/kokoro.web.js` | Apache-2.0; see `KOKORO-LICENSE.txt` |
| `transformers.web.js` | `@huggingface/transformers@3.5.1`, `dist/transformers.min.js` (full browser bundle, renamed locally) | Apache-2.0; see `TRANSFORMERS-LICENSE.txt` |

Kokoro bundle SHA-256: `6067712fe4c43cdb36c762f860a5ab8d96ea1d9c8882466438eb9f3d0d20be8f`.
Transformers bundle SHA-256: `79fad8c1c2fd165bf1e77ace20ce023fab4dc13b6621f0e586c9b8c59c4d09d8`.

Upstream source/build instructions:

- https://github.com/hexgrad/kokoro/tree/main/kokoro.js
- https://github.com/huggingface/transformers.js/tree/3.5.1
- https://github.com/xenova/phonemizer.js (phonemizer wrapper, Apache-2.0)
- https://github.com/espeak-ng/espeak-ng (eSpeak NG phonemizer engine, GPL-3.0-or-later)
- https://github.com/microsoft/onnxruntime (ONNX Runtime, MIT)

Corresponding eSpeak NG and ONNX license texts are included as
`ESPEAK-NG-COPYING.txt` and `ONNX-LICENSE.txt`.

The bundled dependencies retain their upstream licenses. This notice does not
relicense third-party components or model weights. Refer to their upstream
source and model cards when redistributing or modifying them.

To refresh a distribution intentionally, use `npm pack` for the exact version,
extract only its browser distribution and license, verify integrity, update this
notice, and rerun worker, voice, and conversation tests. Do not edit minified
vendor code to work around runtime failures.
