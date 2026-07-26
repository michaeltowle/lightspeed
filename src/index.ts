import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";

export interface Env {
  ANTHROPIC_API_KEY: string;
  LIGHTSPEED_APP_RECORDS: D1Database;
  // Injected at deploy time by the `deploy` npm script (see package.json).
  // Absent under `wrangler dev`, which renders the badge as "local dev".
  DEPLOY_BRANCH?: string;
  DEPLOYED_AT?: string;
}

const CURRENT_AUTHORING_MODEL_ID = "claude-opus-5";

// Blank: new prompts go to the model with no system instruction, so the reply
// answers the prompt itself rather than the old screenshot-probe format.
// Stored rows keep whatever preamble was in force when they were saved, so
// replaying an old prompt still reproduces its original request.
const MODEL_INSTRUCTION_PREAMBLE = "";

const INDEX_PAGE_DOCUMENT = `<!doctype html>
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
    max-width: 52rem;
    margin: 0 auto;
    padding: 1rem 1rem 4rem;
    line-height: 1.45;
  }
  h1 { font-size: 1rem; font-weight: 600; opacity: 0.6; margin: 0 0 1rem; }
  h2 { font-size: 0.85rem; font-weight: 600; opacity: 0.6; margin: 2rem 0 0.75rem; }
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
  ul.shots { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0; padding: 0; list-style: none; }
  ul.shots li {
    border: 1px solid rgba(128,128,128,0.4);
    border-radius: 6px;
    padding: 0.4rem;
    width: 8.5rem;
    font-size: 0.75rem;
  }
  ul.shots img { width: 100%; height: 4.5rem; object-fit: contain; display: block; }
  ul.shots .dims { font-variant-numeric: tabular-nums; opacity: 0.75; margin-top: 0.25rem; }
  ul.shots .drop { margin-top: 0.25rem; font-size: 0.75rem; padding: 0.15rem 0.4rem; }
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
  #saved { list-style: none; margin: 0; padding: 0; }
  #saved li {
    border: 1px solid rgba(128,128,128,0.35);
    border-radius: 6px;
    padding: 0.5rem 0.65rem;
    margin-bottom: 0.4rem;
  }
  #saved .meta { font-size: 0.72rem; opacity: 0.6; font-variant-numeric: tabular-nums; }
  #saved .text { font-size: 0.85rem; margin: 0.15rem 0 0.4rem; }
  #saved .acts { display: flex; gap: 0.4rem; }
  #saved .acts button { font-size: 0.75rem; padding: 0.2rem 0.6rem; }

  #deploy-badge {
    position: fixed;
    right: 1rem;
    bottom: 1rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid rgba(128,128,128,0.3);
    border-radius: 8px;
    background: rgba(127,127,127,0.06);
    backdrop-filter: blur(6px);
    font-size: 0.72rem;
    line-height: 1.6;
    pointer-events: none;
  }
  #deploy-badge .lbl { opacity: 0.55; }
  #deploy-badge .val {
    color: #b06a2c;
    font-variant-numeric: tabular-nums;
  }
  @media (prefers-color-scheme: dark) {
    #deploy-badge .val { color: #d99a5b; }
  }
  @media (max-width: 30rem) {
    #deploy-badge { position: static; margin-top: 2rem; }
  }
</style>
</head>
<body>
<h1>authored math prompts</h1>

<form id="f">
  <textarea id="prompt" placeholder="prompt (optional)"></textarea>
  <ul class="shots" id="shots"></ul>
  <div class="row">
    <label class="filebtn" for="picker">attach images</label>
    <input id="picker" type="file" accept="image/*" multiple />
    <button type="submit" id="go">send &amp; save</button>
    <span class="hint">or paste (&#8984;V / Ctrl+V)</span>
  </div>
</form>

<div id="out"></div>

<h2>saved</h2>
<ul id="saved"></ul>

<div id="deploy-badge"
     data-at="__DEPLOYED_AT__"
     data-branch="__DEPLOY_BRANCH__">
  <div><span class="lbl">deployed</span> <span class="val" id="deploy-when"></span></div>
  <div><span class="lbl">from branch</span> <span class="val" id="deploy-branch"></span></div>
</div>

<script>
(function () {
  var badge = document.getElementById('deploy-badge');
  var at = badge.getAttribute('data-at');
  var branch = badge.getAttribute('data-branch');

  // Rendered in the viewer's local time, so it reads correctly on the phone
  // and both Dells regardless of where the deploy ran.
  function whenText(iso) {
    if (!iso) return 'local dev';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return 'local dev';
    var mons = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var h = d.getHours();
    var ampm = h >= 12 ? 'pm' : 'am';
    h = h % 12; if (h === 0) h = 12;
    var m = d.getMinutes();
    return h + ':' + (m < 10 ? '0' + m : m) + ampm + ' on ' + mons[d.getMonth()] + ' ' + d.getDate();
  }

  document.getElementById('deploy-when').textContent = whenText(at);
  document.getElementById('deploy-branch').textContent = branch ? '#' + branch : '#local';
})();
</script>

<script>
(function () {
  var MAX_SHOTS = 8;
  var MAX_STORED_BYTES = 1000000;   // stay well under D1's 2,000,000 byte BLOB cap
  var MAX_EDGE = 2000;              // downscale ceiling if WebP alone isn't enough

  var shots = [];
  var listEl = document.getElementById('shots');
  var outEl = document.getElementById('out');
  var savedEl = document.getElementById('saved');
  var goEl = document.getElementById('go');
  var promptEl = document.getElementById('prompt');
  var pickerEl = document.getElementById('picker');

  function setOut(text, isError) {
    outEl.textContent = text;
    outEl.className = isError ? 'err' : '';
  }

  function post(payload) {
    return fetch('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        return data;
      });
    });
  }

  function loadImage(dataUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
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

  // Re-encode to WebP, shrinking until the encoded bytes fit under the D1 cap.
  // Returns the dimensions actually stored, not the dimensions pasted.
  function reencode(img) {
    var scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    var quality = 0.85;

    function attempt() {
      var w = Math.max(1, Math.round(img.naturalWidth * scale));
      var h = Math.max(1, Math.round(img.naturalHeight * scale));
      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      var url = canvas.toDataURL('image/webp', quality);
      var base64 = url.slice(url.indexOf(',') + 1);
      var bytes = Math.floor(base64.length * 3 / 4);

      if (bytes <= MAX_STORED_BYTES) {
        return { dataUrl: url, base64: base64, mimeType: 'image/webp', w: w, h: h, byteSize: bytes };
      }
      if (quality > 0.5) { quality -= 0.15; return attempt(); }
      if (scale > 0.25) { scale *= 0.75; return attempt(); }
      return { dataUrl: url, base64: base64, mimeType: 'image/webp', w: w, h: h, byteSize: bytes };
    }
    return attempt();
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
      pending.push(file);
    }

    return Promise.all(pending.map(function (file) {
      return readFile(file).then(loadImage).then(reencode);
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
      li.appendChild(img);

      var dims = document.createElement('div');
      dims.className = 'dims';
      dims.textContent = (idx + 1) + ': ' + shot.w + 'x' + shot.h +
        ' (' + Math.round(shot.byteSize / 1024) + 'kb)';
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

  function renderSaved(rows) {
    savedEl.innerHTML = '';
    if (!rows.length) {
      var empty = document.createElement('li');
      empty.className = 'meta';
      empty.textContent = 'nothing saved yet';
      savedEl.appendChild(empty);
      return;
    }
    rows.forEach(function (row) {
      var li = document.createElement('li');

      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = '#' + row.id + '  ' + row.created_at +
        '  ' + row.attachment_count + ' image(s)  ' + row.model_id;
      li.appendChild(meta);

      var text = document.createElement('div');
      text.className = 'text';
      text.textContent = row.prompt_text || '(no prompt)';
      li.appendChild(text);

      var acts = document.createElement('div');
      acts.className = 'acts';

      var loadBtn = document.createElement('button');
      loadBtn.type = 'button';
      loadBtn.textContent = 'load';
      loadBtn.addEventListener('click', function () { loadPrompt(row.id); });
      acts.appendChild(loadBtn);

      var replayBtn = document.createElement('button');
      replayBtn.type = 'button';
      replayBtn.textContent = 'replay';
      replayBtn.addEventListener('click', function () { replayPrompt(row.id); });
      acts.appendChild(replayBtn);

      li.appendChild(acts);
      savedEl.appendChild(li);
    });
  }

  function refreshSaved() {
    return post({ action: 'list' })
      .then(function (data) { renderSaved(data.rows); })
      .catch(function (err) { setOut(err.message, true); });
  }

  // Read-back: pull a stored prompt and its images back into the composer.
  function loadPrompt(id) {
    setOut('loading #' + id + '...', false);
    return post({ action: 'read', id: id }).then(function (data) {
      promptEl.value = data.prompt_text || '';
      shots = data.attachments.map(function (att) {
        var dataUrl = 'data:' + att.mime_type + ';base64,' + att.base64;
        return {
          dataUrl: dataUrl, base64: att.base64, mimeType: att.mime_type,
          w: att.width_px, h: att.height_px, byteSize: att.byte_size
        };
      });
      render();
      setOut('loaded #' + id + ' (' + shots.length + ' image(s)) -- original reply:\\n' +
        (data.reply_text || '(none)'), false);
    }).catch(function (err) { setOut(err.message, true); });
  }

  function replayPrompt(id) {
    setOut('replaying #' + id + '...', false);
    return post({ action: 'replay', id: id }).then(function (data) {
      setOut('replay of #' + id + ':\\n' + data.reply, false);
    }).catch(function (err) { setOut(err.message, true); });
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

    post({
      action: 'author_and_save',
      prompt: promptEl.value,
      unsaved_image_attachments: shots.map(function (shot) {
        return {
          base64: shot.base64, mimeType: shot.mimeType,
          w: shot.w, h: shot.h, byteSize: shot.byteSize
        };
      })
    }).then(function (data) {
      setOut('saved as #' + data.id + '\\n' + data.reply, false);
      return refreshSaved();
    }).catch(function (err) {
      setOut(err.message, true);
    }).then(function () {
      goEl.disabled = false;
    });
  });

  refreshSaved();
})();
</script>
</body>
</html>`;

interface UnsavedImageAttachment {
  base64: string;
  mimeType: string;
  w: number;
  h: number;
  byteSize: number;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(value: unknown): string {
  // D1 hands BLOBs back as number[] on some paths and ArrayBuffer on others.
  const bytes =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : Array.isArray(value)
        ? Uint8Array.from(value)
        : new Uint8Array(value as ArrayBufferLike);

  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function callLanguageModel(
  env: Env,
  promptText: string,
  shots: { base64: string; mimeType: string }[],
  systemPrompt: string,
  modelId: string,
): Promise<string> {
  // ai@4 always sends `temperature` (it defaults to 0 rather than being
  // omitted). Anthropic removed the sampling params on Opus 4.7 and later,
  // so they must be stripped from the wire or the request 400s.
  const anthropic = createAnthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    fetch: async (input, init) => {
      if (typeof init?.body === "string") {
        const body = JSON.parse(init.body);
        delete body.temperature;
        delete body.top_p;
        delete body.top_k;
        init = { ...init, body: JSON.stringify(body) };
      }
      return fetch(input, init);
    },
  });

  const { text } = await generateText({
    model: anthropic(modelId),
    // Omitted entirely when blank -- sending an empty system string is not the
    // same as sending none, and stored rows may legitimately have no preamble.
    ...(systemPrompt.trim() ? { system: systemPrompt } : {}),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: promptText.trim() || "(no prompt)" },
          ...shots.map((shot) => ({
            type: "image" as const,
            image: shot.base64,
            mimeType: shot.mimeType,
          })),
        ],
      },
    ],
  });

  return text;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== "/") return new Response("Not found", { status: 404 });

    if (request.method === "GET") {
      const attr = (value: string) =>
        value
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");

      const page = INDEX_PAGE_DOCUMENT.replace(
        "__DEPLOYED_AT__",
        attr(env.DEPLOYED_AT ?? ""),
      ).replace(
        "__DEPLOY_BRANCH__",
        attr(env.DEPLOY_BRANCH ?? ""),
      );

      return new Response(page, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    const db = env.LIGHTSPEED_APP_RECORDS;
    const body = await request.json<{
      action?: string;
      id?: number;
      prompt?: string;
      unsaved_image_attachments?: UnsavedImageAttachment[];
    }>();

    try {
      if (body.action === "list") {
        const { results } = await db
          .prepare(
            `SELECT p.id, p.prompt_text, p.model_id, p.reply_text, p.created_at,
                    COUNT(a.id) AS attachment_count
               FROM authored_math_prompt p
               LEFT JOIN math_prompt_image_attachment a
                 ON a.authored_math_prompt_id = p.id
              GROUP BY p.id
              ORDER BY p.id DESC
              LIMIT 50`,
          )
          .all();
        return json({ rows: results });
      }

      if (body.action === "read") {
        const prompt = await db
          .prepare(`SELECT * FROM authored_math_prompt WHERE id = ?`)
          .bind(body.id)
          .first();
        if (!prompt) return json({ error: "no such prompt" }, 404);

        const { results } = await db
          .prepare(
            `SELECT id, ordinal, mime_type, width_px, height_px, byte_size, image_bytes
               FROM math_prompt_image_attachment
              WHERE authored_math_prompt_id = ?
              ORDER BY ordinal`,
          )
          .bind(body.id)
          .all();

        return json({
          ...prompt,
          attachments: results.map((row: Record<string, unknown>) => ({
            id: row.id,
            ordinal: row.ordinal,
            mime_type: row.mime_type,
            width_px: row.width_px,
            height_px: row.height_px,
            byte_size: row.byte_size,
            base64: bytesToBase64(row.image_bytes),
          })),
        });
      }

      if (body.action === "replay") {
        const prompt = await db
          .prepare(`SELECT * FROM authored_math_prompt WHERE id = ?`)
          .bind(body.id)
          .first<{ prompt_text: string; model_id: string; system_prompt: string }>();
        if (!prompt) return json({ error: "no such prompt" }, 404);

        const { results } = await db
          .prepare(
            `SELECT mime_type, image_bytes
               FROM math_prompt_image_attachment
              WHERE authored_math_prompt_id = ?
              ORDER BY ordinal`,
          )
          .bind(body.id)
          .all();

        // Replayed against the stored model_id and system_prompt, not the
        // current ones, so an old prompt reproduces its original request.
        const reply = await callLanguageModel(
          env,
          prompt.prompt_text,
          results.map((row: Record<string, unknown>) => ({
            base64: bytesToBase64(row.image_bytes),
            mimeType: String(row.mime_type),
          })),
          prompt.system_prompt,
          prompt.model_id,
        );
        return json({ reply });
      }

      if (body.action !== "author_and_save") {
        // Explicit, so a typo'd action can't silently spend an API call and
        // write a row by falling through to the save path.
        return json({ error: `unknown action: ${body.action ?? "(none)"}` }, 400);
      }

      const shots = body.unsaved_image_attachments ?? [];
      const promptText = body.prompt ?? "";
      const reply = await callLanguageModel(
        env,
        promptText,
        shots,
        MODEL_INSTRUCTION_PREAMBLE,
        CURRENT_AUTHORING_MODEL_ID,
      );

      const inserted = await db
        .prepare(
          `INSERT INTO authored_math_prompt (prompt_text, model_id, system_prompt, reply_text)
           VALUES (?, ?, ?, ?) RETURNING id`,
        )
        .bind(promptText, CURRENT_AUTHORING_MODEL_ID, MODEL_INSTRUCTION_PREAMBLE, reply)
        .first<{ id: number }>();

      const promptId = inserted!.id;

      if (shots.length) {
        await db.batch(
          shots.map((shot, idx) =>
            db
              .prepare(
                `INSERT INTO math_prompt_image_attachment
                   (authored_math_prompt_id, ordinal, mime_type, width_px, height_px, byte_size, image_bytes)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
              )
              .bind(
                promptId,
                idx,
                shot.mimeType,
                shot.w,
                shot.h,
                shot.byteSize,
                base64ToBytes(shot.base64),
              ),
          ),
        );
      }

      return json({ id: promptId, reply });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: message }, 502);
    }
  },
};
