// Makes the README pictures: docs/media/demo.gif, products.png, order.png and inbox.png.
// Runs the demo shop (examples/demo-tools) and agentdesk with a scripted model instead of
// Claude, so no API key is needed and every run shows the same conversation.
// Run: npm run screenshots (needs ffmpeg for the GIF and `npx playwright install chromium` once).

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { chromium, type Page } from 'playwright';
import { silentLogger } from '../src/logger.js';
import { startAgentdesk } from '../src/start.js';

const OUT = path.resolve('docs/media');
const VIDEO_DIR = path.join(OUT, '.video');
const SHOP = 'http://localhost:8090';
const AGENTDESK = 'http://localhost:8080';
const ADMIN_TOKEN = 'screenshot-admin-token';
const VIEWPORT = { width: 900, height: 720 };

type Step = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
type CallOptions = Parameters<MockLanguageModelV4['doGenerate']>[0];

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};
const say = (text: string): Step => ({
  content: [{ type: 'text', text }],
  finishReason: { unified: 'stop', raw: undefined },
  usage,
  warnings: [],
});
const call = (toolName: string, input: object = {}): Step => ({
  content: [{ type: 'tool-call', toolCallId: `call-${toolName}`, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls', raw: undefined },
  usage,
  warnings: [],
});

/** The demo conversation: picks the next step from the last message, like a model would. */
function nextStep({ prompt }: CallOptions): Step {
  const last = prompt.at(-1);
  if (last?.role === 'tool') {
    const tool = last.content.find((part) => part.type === 'tool-result')?.toolName;
    if (tool === 'list_products')
      return say(
        'Here is what we have in stock. Delivery is free on every order, and returns are free for 30 days.',
      );
    if (tool === 'show_login')
      return say('Happy to check. Please log in with the button below and I will look it up.');
    if (tool === 'my_orders')
      return say(
        'You have two orders:\n\n- **ORD-1001**, Ceramic mug: shipped, arriving Friday.\n- **ORD-1002**, Cotton cap: packed, ships tomorrow.',
      );
  }
  // The visitor's own words, without agentdesk's "[Website chat: ...]" line before them.
  const text =
    last?.role === 'user'
      ? last.content
          .map((part) => (part.type === 'text' ? part.text : ''))
          .join('\n')
          .replace(/^\[Website chat:[^\]]*\]\n?/, '')
      : '';
  if (/sell/i.test(text)) return call('list_products');
  if (/logged in/i.test(text)) return call('my_orders');
  if (/order/i.test(text)) return call('show_login', { reason: 'to see your orders' });
  return say('I can show you our products or look up your order.');
}

const model = new MockLanguageModelV4({
  doGenerate: async (options) => {
    // Long enough for the typing dots to show in the GIF.
    await new Promise((resolve) => setTimeout(resolve, 900));
    return nextStep(options);
  },
});

async function waitFor(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (
      await fetch(url).then(
        (r) => r.ok,
        () => false,
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${url} did not start`);
}

async function conversation(page: Page): Promise<void> {
  await page.goto(SHOP);
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Chat with us' }).click();
  await page.waitForTimeout(1500);

  await page.getByRole('button', { name: 'Show products' }).click();
  await page.getByText('Here is what we have in stock').waitFor();
  await page
    .locator('img[width="72"]')
    .first()
    .evaluate('img => img.complete || new Promise((resolve) => { img.onload = resolve; })');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, 'products.png') });

  await page.getByRole('textbox', { name: 'Message' }).pressSequentially('Where is my order?', { delay: 45 });
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByRole('button', { name: 'Log in' }).waitFor();
  await page.waitForTimeout(1800);

  // The demo shop asks "Pretend to log in?" with confirm().
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.getByText('You have two orders').waitFor();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(OUT, 'order.png') });
}

async function inboxShot(page: Page): Promise<void> {
  await page.goto(`${AGENTDESK}/inbox`);
  await page.getByLabel('Admin token').fill(ADMIN_TOKEN);
  await page.getByRole('button', { name: 'Open inbox' }).click();
  await page
    .getByRole('button', { name: /Website visitor/ })
    .first()
    .click();
  await page.getByText('You have two orders').waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, 'inbox.png') });
}

async function main(): Promise<void> {
  execFileSync('node', ['widget/build.mjs'], { stdio: 'inherit' });
  rmSync(VIDEO_DIR, { recursive: true, force: true });
  mkdirSync(VIDEO_DIR, { recursive: true });

  const secret = randomBytes(32).toString('hex');
  process.env.IDENTITY_SECRET = secret;
  // Chats stay in memory, whatever the shell has set.
  delete process.env.DATABASE_URL;
  delete process.env.AGENTDESK_DATABASE_URL;
  // Shows the mic button. Nothing calls Gemini: the script never starts a voice call.
  process.env.GEMINI_API_KEY ??= 'not-used';
  // The team inbox (/inbox) logs in with it.
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;

  const shop = spawn('npx', ['tsx', 'examples/demo-tools/server.ts'], {
    env: { ...process.env, IDENTITY_SECRET: secret, PORT: '8090' },
    stdio: 'ignore',
  });
  const agentdesk = await startAgentdesk({
    configFile: 'agentdesk.config.example.yaml',
    model,
    log: silentLogger,
  });
  const browser = await chromium.launch();
  try {
    await waitFor(SHOP);
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      recordVideo: { dir: VIDEO_DIR, size: VIEWPORT },
    });
    await conversation(await context.newPage());
    await context.close();

    // The same conversation in the team inbox.
    const inbox = await browser.newPage({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 2 });
    await inboxShot(inbox);
    await inbox.close();

    const video = readdirSync(VIDEO_DIR).find((f) => f.endsWith('.webm'));
    if (!video) throw new Error('No video was recorded');
    execFileSync('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-i',
      path.join(VIDEO_DIR, video),
      '-vf',
      'fps=12,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
      '-loop',
      '0',
      path.join(OUT, 'demo.gif'),
    ]);
    console.log(`Wrote ${OUT}/demo.gif, products.png, order.png, inbox.png`);
  } finally {
    await browser.close();
    await agentdesk.close();
    shop.kill();
    rmSync(VIDEO_DIR, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
