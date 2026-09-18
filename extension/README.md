# ABO Browser Extension (Phase 3A)

Production Manifest V3 Chrome/Edge extension for **read-only** browser observation.

## Build

```bash
npm install
npm run build --workspace=@abo/extension
```

Output: `extension/dist/` (Load unpacked)

## Install in Chrome/Edge

1. Open `chrome://extensions` or `edge://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select `extension/dist`
4. Ensure Observer is running: `npm start` → http://127.0.0.1:3847/
5. Open popup → confirm **Connected**
6. Browse http://127.0.0.1:3000/ or the extension test page served by Observer

## Privacy

Never captures passwords, tokens, cookies, API keys, or sensitive form values.  
Redaction runs in the content script **and** before network send.

## Observation only

Does **not** click, type, submit, navigate, or modify pages automatically.
