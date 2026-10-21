# Third-party software and optional models

The MIT license in `LICENSE` covers original Yinyuetai Studio application code and SofunAI's original contributions. It does not relicense third-party software, models, user reference audio or generated music.

## lamejs / LAME

MP3 export loads **lamejs 1.2.1** as a separate JavaScript worker dependency. Copyright and author information are retained in the distributed dependency. lamejs is by Alex Zhukov and incorporates the LAME MP3 encoder; it is licensed under **LGPL-3.0**.

- Project/source: https://github.com/zhuker/lamejs
- LAME project: https://lame.sourceforge.io/
- Exact upstream npm source package: https://registry.npmjs.org/lamejs/-/lamejs-1.2.1.tgz
- License: `licenses/LGPL-3.0.txt` and its incorporated GPL terms in `licenses/GPL-3.0.txt`.
- Upstream notice: `licenses/lamejs-NOTICE.txt`.

The application uses the unmodified library through `node_modules/lamejs/lame.min.js`; its source files remain in the npm dependency. To use a modified encoder, replace that dependency with your compatible version and rebuild the app using the public packaging instructions. No private signing key is required for these ad hoc builds. Preserve LGPL notices and provide the corresponding source for any modified library you redistribute.

`use-strict`, a transitive dependency of lamejs, is MIT licensed; its notice is included in `licenses/use-strict-LICENSE.txt`. Electron includes Chromium, Node.js and their third-party notices in the framework distributed with the application. Packaging/build dependencies retain their respective licenses and are not relicensed by the application.

## Optional model installations

Model weights and upstream inference runtimes are **not bundled** in the source repository or application installers. The user selects and installs them separately. The model center links to the relevant license before installation. Availability, access conditions and licenses may change; check the source linked by the selected model.

- MiniMax Music 3: https://huggingface.co/MiniMaxAI/MiniMax-Music3/blob/main/LICENSE
- Community MLX conversion: https://huggingface.co/mlx-community/MiniMax-Music3-mxfp8/blob/main/LICENSE (a community conversion, not an official MiniMax MLX release).
- Stable Audio Open: https://huggingface.co/stabilityai/stable-audio-open-1.0/blob/main/LICENSE
- Stable Audio 3: https://github.com/Stability-AI/stable-audio-3/blob/main/LICENSE.md
- ACE-Step 1.0: https://github.com/ace-step/ACE-Step/blob/main/LICENSE
- ACE-Step 1.5: https://github.com/ace-step/ACE-Step-1.5/blob/main/LICENSE
- ComfyUI: https://github.com/Comfy-Org/ComfyUI
- mlx-audio: https://github.com/Blaizzy/mlx-audio

Cloud providers have their own terms, credentials and billing. Suno support is a configurable third-party/self-hosted compatible endpoint; the application does not claim an official public Suno API. Users are responsible for the rights to reference audio and for the terms applicable to generated output; the application's MIT license does not grant those rights.
