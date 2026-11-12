/**
 * agentdesk's own inbox page (/inbox), for teams without an admin of their own. It asks for
 * ADMIN_TOKEN once per browser tab (sessionStorage) and draws inbox.js full screen.
 */
export const INBOX_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Inbox · agentdesk</title>
<style>
  html, body { margin: 0; height: 100%; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; background: #f4f6f9; color: #0f172a; }
  [hidden] { display: none !important; }
  #inbox { height: 100vh; }
  form { max-width: 360px; margin: 18vh auto; display: grid; gap: 10px; padding: 0 16px; }
  input, button { font: inherit; padding: 10px 12px; border-radius: 8px; border: 1px solid #cbd5e1; }
  button { background: #2563eb; color: #fff; border: 0; font-weight: 600; cursor: pointer; }
  p { margin: 0; color: #64748b; font-size: 14px; }
</style>
</head>
<body>
<form id="login" hidden>
  <h1 style="margin:0;font-size:20px">agentdesk inbox</h1>
  <p>Paste your ADMIN_TOKEN. It stays in this tab only.</p>
  <input id="token" type="password" autocomplete="off" aria-label="Admin token" required>
  <button type="submit">Open inbox</button>
  <p id="error" style="color:#b91c1c"></p>
</form>
<div id="inbox" hidden></div>
<script src="/inbox.js"></script>
<script>
  const KEY = 'agentdesk-admin-token';
  const form = document.getElementById('login');
  async function open(token) {
    const res = await fetch('/v1/admin/inbox-config', { headers: { authorization: 'Bearer ' + token } });
    if (!res.ok) throw new Error('That token was not accepted.');
    sessionStorage.setItem(KEY, token);
    form.hidden = true;
    const el = document.getElementById('inbox');
    el.hidden = false;
    AgentDeskInbox.mount(el, { token: () => sessionStorage.getItem(KEY) || '', theme: { height: '100vh' } });
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    open(document.getElementById('token').value.trim()).catch((err) => {
      document.getElementById('error').textContent = err.message;
    });
  });
  const saved = sessionStorage.getItem(KEY);
  if (saved) open(saved).catch(() => { sessionStorage.removeItem(KEY); form.hidden = false; });
  else form.hidden = false;
</script>
</body>
</html>
`;
