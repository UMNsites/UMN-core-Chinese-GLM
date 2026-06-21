export const config = { maxDuration: 60 };

var qaContent = null;
var qaFetchedAt = 0;
var CACHE_MS = 5 * 60 * 1000;

async function getQAContent() {
  if (qaContent && Date.now() - qaFetchedAt < CACHE_MS) return qaContent;
  try {
    var res = await fetch('https://umnsites.github.io/Q-A/');
    var html = await res.text();
    var text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    qaContent = text.slice(0, 30000);
    qaFetchedAt = Date.now();
  } catch (e) {
    qaContent = '[Could not fetch Q-A page]';
  }
  return qaContent;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  try {
    var body = await req.body;
    var messages = body.messages || [];
    var model = body.model || 'gemini-2.5-flash';
    var temperature = body.temperature != null ? body.temperature : 0.7;
    var max_tokens = body.max_tokens || 8192;

    var contents = [];
    var systemInstruction = undefined;

    var qaText = await getQAContent();
    var knowledgeBase = 'You are UMN Core, the official AI assistant for UMN. You have access to the following content from the UMN Q-A knowledge base page (https://umnsites.github.io/Q-A/). Use this information to answer questions accurately. If the user asks something not covered by this content, use your general knowledge but note that it may not be specific to UMN. Always be helpful, concise, and friendly.\n\n--- UMN Q-A KNOWLEDGE BASE ---\n' + qaText + '\n--- END KNOWLEDGE BASE ---';

    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];
      if (msg.role === 'system') {
        systemInstruction = { parts: [{ text: knowledgeBase + '\n\n' + msg.content }] };
      } else {
        contents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }]
        });
      }
    }

    if (!systemInstruction) {
      systemInstruction = { parts: [{ text: knowledgeBase }] };
    }

    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':streamGenerateContent?alt=sse&key=' + apiKey;

    var response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: contents,
        systemInstruction: systemInstruction,
        generationConfig: {
          temperature: temperature,
          maxOutputTokens: max_tokens
        }
      })
    });

    if (!response.ok) {
      var errMsg = 'Gemini API returned ' + response.status;
      try { var errBody = await response.json(); errMsg = errBody.error && errBody.error.message ? errBody.error.message : errMsg; } catch (e) {}
      return res.status(response.status).json({ error: errMsg });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    var previousText = '';
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';

    while (true) {
      var result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      var lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (var j = 0; j < lines.length; j++) {
        var trimmed = lines[j].trim();
        if (!trimmed.startsWith('data: ')) continue;
        var data = trimmed.slice(6);
        if (!data || data === '[DONE]') continue;
        try {
          var json = JSON.parse(data);
          var fullText = json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts && json.candidates[0].content.parts[0] && json.candidates[0].content.parts[0].text;
          var finish = json.candidates && json.candidates[0] && json.candidates[0].finishReason;
          if (fullText !== undefined) {
            var delta = fullText.slice(previousText.length);
            previousText = fullText;
            if (delta) {
              res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: delta }, index: 0 }] }) + '\n\n');
            }
          }
          if (finish === 'STOP') {
            res.write('data: [DONE]\n\n');
          }
        } catch (e) {}
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.write('data: ' + JSON.stringify({ error: err.message }) + '\n\n');
      res.end();
    }
  }
}
