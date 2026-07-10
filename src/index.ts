import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";

export interface Env {
  ANTHROPIC_API_KEY: string;
}

const SING_PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>sing</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; }
  #log { white-space: pre-wrap; margin-bottom: 1rem; }
  #log p { margin: 0.5rem 0; }
  form { display: flex; gap: 0.5rem; }
  input { flex: 1; padding: 0.5rem; }
  button { padding: 0.5rem 1rem; }
</style>
</head>
<body>
<div id="log"></div>
<form id="f">
  <input id="msg" autocomplete="off" placeholder="say something to haiku" />
  <button>send</button>
</form>
<script>
  const log = document.getElementById('log');
  const form = document.getElementById('f');
  const input = document.getElementById('msg');

  function addLine(who, text) {
    const p = document.createElement('p');
    p.textContent = who + ': ' + text;
    log.appendChild(p);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    addLine('you', text);
    input.value = '';

    const res = await fetch('/sing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: text }),
    });
    const data = await res.json();
    addLine('haiku', data.reply);

    if (data.reply.toLowerCase().includes('fa la la')) {
      document.title = 'fa la la';
      document.body.style.background = 'yellow';
    }
  });
</script>
</body>
</html>`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/sing" && request.method === "GET") {
      return new Response(SING_PAGE, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/sing" && request.method === "POST") {
      const { message } = await request.json<{ message: string }>();
      const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });

      const { text } = await generateText({
        model: anthropic("claude-haiku-4-5"),
        system:
          "This is a wiring test for an API integration. Reply with exactly the phrase 'fa la la' and nothing else.",
        prompt: message,
      });

      return new Response(JSON.stringify({ reply: text }), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
