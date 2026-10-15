import { test, expect } from '@playwright/test';

const phrases = [
  'It is certain.', 'It is decidedly so.', 'Without a doubt.', 'Yes definitely.',
  'You may rely on it.', 'As I see it, yes.', 'Most likely.', 'Outlook good.',
  'Yes.', 'Signs point to yes.', 'Reply hazy, try again.', 'Ask again later.',
  'Better not tell you now.', 'Cannot predict now.', 'Concentrate and ask again.',
  "Don't count on it.", 'My reply is no.', 'My sources say no.', 'Outlook not so good.', 'Very doubtful.',
];
const result = { answer: 'It is decidedly so.', verdict: 'affirmative', criteria: [], summary: 'Test reasoning' };
const shake = page => page.getByRole('button', { name: 'Shake', exact: true }).click();

test('numbered back, shake, turn, clean die, and repeated question', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/ask', route => route.fulfill({ json: result }));
  await page.goto('/');
  await expect(page.locator('.number-disc')).toHaveText('8');
  await page.getByRole('textbox').fill('Should I try this?');
  await shake(page);
  await expect(page.locator('.ball-stage')).toHaveClass(/shaking/);
  await expect(page.locator('.ball-stage')).toHaveClass(/answered/);
  await expect(page.locator('.ball-rotor')).toHaveClass(/turned/);
  await expect(page.locator('.answer-window')).toHaveText('IT IS DECIDEDLY SO');
  await expect(page.locator('details')).not.toHaveAttribute('open');
  await shake(page);
  await expect(page.locator('.ball-stage')).toHaveClass(/resetting/);
  await expect(page.locator('.ball-stage')).toHaveClass(/answered/);
  expect(errors).toEqual([]);
});

test('slow API stops shaking, prevents duplicate submits, then errors recover', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/ask', async route => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 3200));
    await route.fulfill({ json: result });
  });
  await page.goto('/');
  await page.getByRole('textbox').fill('Should I try this?');
  await shake(page);
  await expect(page.locator('.ball-stage')).toHaveClass(/waiting/);
  await expect(page.locator('.answer')).toBeEmpty();
  await expect(page.getByRole('button', { name: 'Asking…' })).toBeDisabled();
  await expect(page.locator('.ball-stage')).toHaveClass(/answered/);
  expect(calls).toBe(1);
  await page.unroute('**/api/ask');
  await page.route('**/api/ask', route => route.fulfill({ status: 504, json: { error: 'Try again' } }));
  await shake(page);
  await expect(page.getByRole('alert')).toHaveText('Try again');
  await page.waitForTimeout(2300);
  await expect(page.locator('.ball-stage')).toHaveClass(/idle/);
});

test('all twenty die answers fit at narrow mobile size with reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/ask', route => route.fulfill({ json: result }));
  await page.goto('/?q=Should%20I%20try%20this');
  await expect(page.locator('.ball-stage')).toHaveClass(/answered/);
  await expect(page.getByRole('textbox')).toHaveValue('Should I try this');
  for (const phrase of phrases) {
    // Exercise the exact die layout without twenty API calls/animation waits.
    const fits = await page.locator('.answer').evaluate((el, phrase) => {
      const text = phrase.replace(/[.,!?:;“”"‘’]/g, '').toUpperCase();
      el.textContent = text;
      el.classList.toggle('answer-long', text.length > 22);
      const r = el.getBoundingClientRect();
      const die = el.parentElement.getBoundingClientRect();
      // Each line must stay inside the triangle, not just its rectangular box.
      const range = document.createRange();
      range.selectNodeContents(el);
      return [...range.getClientRects()].every(line => {
        const halfWidth = ((line.top - die.top) / die.height - .02) / .87 * die.width / 2;
        const center = die.left + die.width / 2;
        return line.left >= center - halfWidth && line.right <= center + halfWidth && line.bottom < die.top + die.height * .89;
      }) && r.width + 1 >= el.scrollWidth;
    }, phrase);
    expect(fits, phrase).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('.ball-motion')).toHaveCSS('animation-name', 'none');
});
