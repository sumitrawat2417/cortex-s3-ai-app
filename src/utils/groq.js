// -------------------------------------------------------------
// Groq Cloud AI API Client (Whisper STT + Fast LLM + Vision AI)
// -------------------------------------------------------------

/**
 * Transcribe spoken audio using Groq Whisper Large V3 Turbo
 */
export async function transcribeWithGroq(wavBlob, apiKey) {
  const t0 = performance.now();
  const formData = new FormData();
  formData.append('model', 'whisper-large-v3-turbo');
  formData.append('file', wavBlob, 'audio.wav');

  const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`
    },
    body: formData
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Whisper STT failed (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  const sttMs = Math.round(performance.now() - t0);
  return {
    text: data.text?.trim() || '',
    sttMs
  };
}

/**
 * Text Question Answering via Groq LLM (openai/gpt-oss-20b)
 */
export async function askGroqLLM(question, apiKey) {
  const t0 = performance.now();
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'openai/gpt-oss-20b',
      messages: [
        {
          role: 'system',
          content: 'You are an AI smartwatch assistant. Answer concisely and clearly in 1 or 2 sentences.'
        },
        {
          role: 'user',
          content: question
        }
      ],
      max_tokens: 220
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`LLM failed (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  const llmMs = Math.round(performance.now() - t0);
  const choice = data.choices?.[0]?.message;
  let answer = choice?.content?.trim();

  // If reasoning model put answer in reasoning buffer
  if (!answer && choice?.reasoning) {
    answer = choice.reasoning.trim();
  }

  return {
    answer: answer || 'Sorry, I could not generate an answer.',
    llmMs
  };
}

/**
 * Vision AI: Read text & understand images via Groq (qwen/qwen3.8-27b)
 */
export async function askGroqVision(base64Image, customPrompt, apiKey) {
  const t0 = performance.now();
  const prompt = customPrompt && customPrompt.trim().length > 0
    ? customPrompt.trim()
    : 'Read and extract all visible text from this image, then explain or answer clearly.';

  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'qwen/qwen3.8-27b',
      messages: [
        {
          role: 'system',
          content: 'You are an AI smartwatch assistant with a small watch screen. Answer directly, concisely, and immediately in 1-2 punchy sentences. Do not use filler or preamble like "Based on the image...". Give the extracted text or answer immediately.'
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: prompt
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`
              }
            }
          ]
        }
      ],
      max_tokens: 350
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Vision AI failed (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  const visionMs = Math.round(performance.now() - t0);
  const answer = data.choices?.[0]?.message?.content?.trim() || 'No answer generated from image.';

  return {
    answer,
    visionMs
  };
}
