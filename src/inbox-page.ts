/**
 * agentdesk's own inbox page (/inbox), for teams without an admin of their own. It asks for
 * ADMIN_TOKEN once per browser tab (sessionStorage) and draws inbox.js full screen, light or dark
 * to match the device.
 */
export const INBOX_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f3f5f7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0b1118" media="(prefers-color-scheme: dark)">
<title>Inbox · agentdesk</title>
<style>
  :root {
    --bg: #f3f5f7; --card: #ffffff; --border: #dde2e8; --text: #16212e; --muted: #5b6877;
    --accent: #0b6a7f; --on-accent: #ffffff; --error: #b42318;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b1118; --card: #111a24; --border: #243241; --text: #e6edf3; --muted: #93a1b0;
      --accent: #3fb3cc; --on-accent: #04222a; --error: #ff8a80;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg); color: var(--text); -webkit-font-smoothing: antialiased;
  }
  [hidden] { display: none !important; }
  #inbox { height: 100vh; height: 100dvh; }
  main {
    min-height: 100dvh; display: grid; place-items: center;
    padding: max(24px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom));
  }
  form {
    width: 100%; max-width: 380px; display: grid; gap: 14px; padding: 28px;
    background: var(--card); border: 1px solid var(--border); border-radius: 16px;
  }
  h1 { margin: 0; font-size: 20px; letter-spacing: -0.01em; }
  p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.5; }
  label { display: grid; gap: 6px; font-size: 13px; font-weight: 600; }
  input, button { font: inherit; font-size: 16px; min-height: 46px; border-radius: 10px; }
  input {
    padding: 0 12px; border: 1px solid var(--border); background: var(--bg); color: var(--text);
  }
  input:focus-visible { outline: 0; border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent); }
  button { border: 0; background: var(--accent); color: var(--on-accent); font-weight: 650; cursor: pointer; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  #error { color: var(--error); min-height: 1.5em; }
</style>
</head>
<body>
<main id="login" hidden>
  <form>
    <h1>Team inbox</h1>
    <p>Paste your ADMIN_TOKEN to read and answer chats. It stays in this browser tab only.</p>
    <label>Admin token
      <input id="token" type="password" autocomplete="off" required>
    </label>
    <button type="submit">Open inbox</button>
    <p id="error" role="alert"></p>
  </form>
</main>
<div id="inbox" hidden></div>
<script src="/inbox.js"></script>
<script>
  const KEY = 'agentdesk-admin-token';
  const login = document.getElementById('login');
  const DARK = {
    bg: '#111a24', surface: '#0b1118', border: '#243241', text: '#e6edf3', muted: '#93a1b0',
    primary: '#e6edf3', accent: '#3fb3cc', 'on-accent': '#04222a', customer: '#18232f',
    ai: '#1a2b45', team: '#14382b', system: '#111a24', warn: '#f0b44c', error: '#ff8a80', ok: '#5fd39a',
  };
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  async function open(token) {
    const res = await fetch('/v1/admin/inbox-config', { headers: { authorization: 'Bearer ' + token } });
    if (!res.ok) throw new Error('That token was not accepted.');
    sessionStorage.setItem(KEY, token);
    login.hidden = true;
    const el = document.getElementById('inbox');
    el.hidden = false;
    AgentDeskInbox.mount(el, {
      token: () => sessionStorage.getItem(KEY) || '',
      theme: { ...(dark ? DARK : {}), height: '100dvh', radius: '0px' },
    });
  }
  login.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    open(document.getElementById('token').value.trim()).catch((err) => {
      document.getElementById('error').textContent = err.message;
    });
  });
  const saved = sessionStorage.getItem(KEY);
  if (saved) open(saved).catch(() => { sessionStorage.removeItem(KEY); login.hidden = false; });
  else login.hidden = false;
</script>
</body>
</html>
`;
