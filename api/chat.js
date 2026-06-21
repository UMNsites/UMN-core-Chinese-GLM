export const config = { maxDuration: 60 };

// Cache the Q-A page content so we don't fetch it every request
let qaContent = null;
let qaFetchedAt = 0;
const CACHE_MS = 5 * 60 * 1000;

async function getQAContent() {
  if (qaContent && Date.now() - qaFetchedAt < CACHE_MS) return qaContent;
  try {
    const res = await fetch('https://umnsites.github.io/Q-A/');
    const html = await res.text();
    // Strip HTML tags, decode entities, collapse whitespace
    const text = html
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
    qaContent = text.slice(0, 30000); // cap to stay within context limits
    qaFetchedAt = Date.now();
  } catch (e) {
    qaContent = '[Could not fetch Q-A page content]';
  }
  return qaContent;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  try {
    const { messages, model, temperature, max_tokens } = await req.body;

    // Build Gemini format
    const contents = [];
    let systemInstruction = undefined;

    // Inject Q-A knowledge base
    const qaText = await getQAContent();
    const knowledgeBase = `You are UMN Core, the official AI assistant for UMN. You have access to the following content from the UMN Q-A knowledge base page (https://umnsites.github.io/Q-A/). Use this information to answer questions accurately. If the user asks something not covered by this content, use your general knowledge but note that it may not be specific to UMN. Always be helpful, concise, and friendly.\n\n--- UMN Q-A KNOWLEDGE BASE ---\n${qaText}\n--- END KNOWLEDGE BASE ---`;

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = { parts: [{ text: knowledgeBase + '\n\n' + msg.content }] };
      } else {
        contents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }]
        });
      }
    }

    // If no system message was provided, still inject the knowledge base
    if (!systemInstruction) {
      systemInstruction = { parts: [{ text: knowledgeBase }] };
    }

    const geminiModel = model || 'gemini-2.5-flash-preview-05-20';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:streamGenerateContent?alt=sse&key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction,
        generationConfig: {
          temperature: temperature ?? 0.7,
          maxOutputTokens: max_tokens ?? 8192,
        }
      })
    });

    if (!response.ok) {
      let errMsg = `Gemini API returned ${response.status}`;
      try { const e = await response.json(); errMsg = e.error?.message || errMsg; } catch (_) {}
      return res.status(response.status).json({ error: errMsg });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let previousText = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (!data || data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const fullText = json.candidates?.[0]?.content?.parts?.[0]?.text;
          const finish = json.candidates?.[0]?.finishReason;
          if (fullText !== undefined) {
            const delta = fullText.slice(previousText.length);
            previousText = fullText;
            if (delta) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: delta }, index: 0 }] })}\n\n`);
          }
          if (finish === 'STOP') res.write('data: [DONE]\n\n');
        } catch (e) {}
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else { res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`); res.end(); }
  }
}
