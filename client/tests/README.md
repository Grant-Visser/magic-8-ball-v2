# Ball interaction tests

From `client/`:

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

Use `CHROMIUM_PATH=/path/to/chromium npm run test:e2e` to reuse an installed browser.
The suite starts Vite automatically and mocks `/api/ask`; no credentials or paid model calls are needed.

Coverage: numbered back, shake/turn/reveal, repeat questions, slow responses,
disabled duplicate submissions, failed-response recovery, shared-question startup,
reduced motion, and all 20 answer phrases inside the triangle at 320px viewport width.

The 1.2-second shake runs once, then the ball turns to the window. A slow API leaves
the window empty until the answer arrives; it does not loop the shake indefinitely.
Reasoning remains available in the collapsed “Behind the answer” disclosure.
