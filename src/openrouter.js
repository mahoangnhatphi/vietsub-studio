const MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free';

export async function translateOpenRouter(segments, key, signal, progress) {
  const translated = [];
  for (let i = 0; i < segments.length; i += 25) {
    const batch = segments.slice(i, i + 25);
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'X-Title': 'VietSub Studio' },
      body: JSON.stringify({
        model: MODEL, temperature: 0.2,
        messages: [
          { role: 'system', content: 'Translate subtitles into concise natural Vietnamese. Return ONLY a JSON array of {id,text}. Preserve every id. Do not merge lines.' },
          { role: 'user', content: JSON.stringify(batch.map(({ id, text }) => ({ id, text }))) },
        ],
      }),
    });
    if (!response.ok) throw new Error(`OpenRouter HTTP ${response.status}`);
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('OpenRouter trả về nội dung rỗng.');
    const items = JSON.parse(content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim());
    if (!Array.isArray(items)) throw new Error('OpenRouter trả về JSON không hợp lệ.');
    const map = new Map(items.map((item) => [item.id, item.text]));
    for (const s of batch) {
      const text = map.get(s.id);
      if (typeof text !== 'string' || !text.trim()) throw new Error(`OpenRouter thiếu dòng ${s.id}.`);
      translated.push({ ...s, text: text.trim() });
    }
    progress(`OpenRouter: ${translated.length}/${segments.length} câu`, translated.length / segments.length);
  }
  return translated;
}
