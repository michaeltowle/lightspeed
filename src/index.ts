import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";

export interface Env {
  ANTHROPIC_API_KEY: string;
}

const TMPNAME_SYSTEM_PROMPT_01 = [
  "This is a wiring test for image attachment.",
  "",
  "If no images are attached, reply with exactly: no screenshot",
  "",
  "If images are attached, reply with one line per image, in order, formatted:",
  "1: 1280x720",
  "2: 390x844",
  "",
  "Give your best visual estimate of each image's pixel dimensions.",
  "Reply with nothing else -- no preamble, no explanation, no units.",
].join("\n");

const TMPNAME_PAGE_HTML_01 = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>lightspeed</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    max-width: 46rem;
    margin: 0 auto;
    padding: 1rem 1rem 4rem;
    line-height: 1.45;
  }
  h1 { font-size: 1rem; font-weight: 600; opacity: 0.6; margin: 0 0 1rem; }
  form { display: flex; flex-direction: column; gap: 0.75rem; }
  textarea {
    width: 100%;
    min-height: 5rem;
    padding: 0.6rem;
    font: inherit;
    border: 1px solid rgba(128,128,128,0.5);
    border-radius: 6px;
    resize: vertical;
    background: transparent;
    color: inherit;
  }
  .row { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  button, label.filebtn {
    padding: 0.55rem 1rem;
    font: inherit;
    border: 1px solid rgba(128,128,128,0.5);
    border-radius: 6px;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  button[type=submit] { font-weight: 600; }
  button:disabled { opacity: 0.45; cursor: default; }
  input[type=file] { display: none; }
  .hint { font-size: 0.8rem; opacity: 0.6; }
  #shots { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0; padding: 0; list-style: none; }
  #shots li {
    border: 1px solid rgba(128,128,128,0.4);
    border-radius: 6px;
    padding: 0.4rem;
    width: 8.5rem;
    font-size: 0.75rem;
  }
  #shots img { width: 100%; height: 4.5rem; object-fit: contain; display: block; }
  #shots .dims { font-variant-numeric: tabular-nums; opacity: 0.75; margin-top: 0.25rem; }
  #shots .drop { margin-top: 0.25rem; font-size: 0.75rem; padding: 0.15rem 0.4rem; }
  #out {
    margin-top: 1.25rem;
    padding: 0.75rem;
    border: 1px solid rgba(128,128,128,0.4);
    border-radius: 6px;
    white-space: pre-wrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85rem;
    min-height: 2.5rem;
  }
  #out.err { border-color: #c0392b; color: #c0392b; }
  #truth { margin-top: 0.5rem; font-size: 0.75rem; opacity: 0.6; font-family: ui-monospace, Menlo, monospace; white-space: pre-wrap; }
</style>
</head>
<body>
<h1>screenshot probe</h1>

<form id="f">
  <textarea id="prompt" placeholder="prompt (optional)"></textarea>
  <ul id="shots"></ul>
  <div class="row">
    <label class="filebtn" for="picker">attach images</label>
    <input id="picker" type="file" accept="image/*" multiple />
    <button type="submit" id="go">send</button>
    <span class="hint">or paste (&#8984;V / Ctrl+V)</span>
  </div>
</form>

<div id="out"></div>
<div id="truth"></div>

<script>
(function () {
  var MAX_SHOTS = 8;
  var MAX_BYTES = 5 * 1024 * 1024;

  var shots = [];
  var listEl = document.getElementById('shots');
  var outEl = document.getElementById('out');
  var truthEl = document.getElementById('truth');
  var goEl = document.getElementById('go');
  var promptEl = document.getElementById('prompt');
  var pickerEl = document.getElementById('picker');

  function setOut(text, isError) {
    outEl.textContent = text;
    outEl.className = isError ? 'err' : '';
  }

  function measure(dataUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        resolve({ w: img.naturalWidth, h: img.naturalHeight });
      };
      img.onerror = function () { reject(new Error('could not decode image')); };
      img.src = dataUrl;
    });
  }

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result)); };
      fr.onerror = function () { reject(new Error('could not read file')); };
      fr.readAsDataURL(file);
    });
  }

  function addFiles(files) {
    var pending = [];
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (!file || file.type.indexOf('image/') !== 0) continue;
      if (shots.length + pending.length >= MAX_SHOTS) {
        setOut('limit is ' + MAX_SHOTS + ' images', true);
        break;
      }
      if (file.size > MAX_BYTES) {
        setOut(file.name + ' is over 5MB', true);
        continue;
      }
      pending.push(file);
    }

    return Promise.all(pending.map(function (file) {
      return readFile(file).then(function (dataUrl) {
        return measure(dataUrl).then(function (dims) {
          return {
            name: file.name || 'pasted',
            mimeType: file.type,
            dataUrl: dataUrl,
            base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
            w: dims.w,
            h: dims.h
          };
        });
      });
    })).then(function (added) {
      shots = shots.concat(added);
      render();
    }).catch(function (err) {
      setOut(err.message, true);
    });
  }

  function render() {
    listEl.innerHTML = '';
    shots.forEach(function (shot, idx) {
      var li = document.createElement('li');

      var img = document.createElement('img');
      img.src = shot.dataUrl;
      img.alt = shot.name;
      li.appendChild(img);

      var dims = document.createElement('div');
      dims.className = 'dims';
      dims.textContent = (idx + 1) + ': ' + shot.w + 'x' + shot.h;
      li.appendChild(dims);

      var drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'drop';
      drop.textContent = 'remove';
      drop.addEventListener('click', function () {
        shots.splice(idx, 1);
        render();
      });
      li.appendChild(drop);

      listEl.appendChild(li);
    });
  }

  pickerEl.addEventListener('change', function () {
    addFiles(pickerEl.files);
    pickerEl.value = '';
  });

  document.addEventListener('paste', function (e) {
    if (!e.clipboardData) return;
    var files = [];
    var items = e.clipboardData.items || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind !== 'file') continue;
      var file = items[i].getAsFile();
      if (file) files.push(file);
    }
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });

  document.getElementById('f').addEventListener('submit', function (e) {
    e.preventDefault();
    goEl.disabled = true;
    setOut('...', false);
    truthEl.textContent = '';

    fetch('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: promptEl.value,
        tmpnameShots: shots.map(function (shot) {
          return { base64: shot.base64, mimeType: shot.mimeType };
        })
      })
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        return data;
      });
    }).then(function (data) {
      setOut(data.reply, false);
      if (shots.length) {
        truthEl.textContent = 'browser says: ' + shots.map(function (shot, idx) {
          return (idx + 1) + ': ' + shot.w + 'x' + shot.h;
        }).join('  ');
      }
    }).catch(function (err) {
      setOut(err.message, true);
    }).then(function () {
      goEl.disabled = false;
    });
  });
})();
</script>
</body>
</html>`;

interface TmpnameShot01 {
  base64: string;
  mimeType: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(TMPNAME_PAGE_HTML_01, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/" && request.method === "POST") {
      const { prompt, tmpnameShots } = await request.json<{
        prompt?: string;
        tmpnameShots?: TmpnameShot01[];
      }>();
      const shots = tmpnameShots ?? [];
      const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });

      try {
        const { text } = await generateText({
          model: anthropic("claude-opus-5"),
          system: TMPNAME_SYSTEM_PROMPT_01,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt?.trim() || "(no prompt)" },
                ...shots.map((shot) => ({
                  type: "image" as const,
                  image: shot.base64,
                  mimeType: shot.mimeType,
                })),
              ],
            },
          ],
        });

        return new Response(JSON.stringify({ reply: text }), {
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new Response(JSON.stringify({ error: message }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
