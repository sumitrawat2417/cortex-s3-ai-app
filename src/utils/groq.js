// -------------------------------------------------------------
// Groq Cloud AI API Client (Whisper STT + Fast LLM + Vision AI)
// -------------------------------------------------------------

/**
 * Transcribe spoken audio using Groq Whisper Large V3 Turbo
 */
export async function transcribeWithGroq(wavBlob, apiKey, prompt) {
  const cleanKey = (apiKey || '').trim();
  if (!cleanKey) {
    throw new Error('Groq API Key is missing! Click ⚙️ Settings in the top-right and paste your Groq key.');
  }

  const t0 = performance.now();
  const formData = new FormData();
  formData.append('model', 'whisper-large-v3-turbo');
  formData.append('file', wavBlob, 'audio.wav');
  if (prompt) {
    formData.append('prompt', prompt);
  }

  const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cleanKey}`
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
 * Classify complex or natural language commands into a watch command tag via Llama-3.1-8B
 */
export async function classifyCommandWithLLM(utterance, apiKey) {
  const cleanKey = (apiKey || '').trim();
  if (!cleanKey) return null;

  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cleanKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        temperature: 0.1,
        max_tokens: 30,
        messages: [
          {
            role: 'system',
            content: `Classify the user utterance into exactly ONE command tag:
OPEN:SETTINGS
OPEN:CALC
OPEN:MUSIC
OPEN:MY_QRS
OPEN:AI_ASSISTANT
OPEN:CLOCK
OPEN:CALENDAR
OPEN:FLASHLIGHT
OPEN:NOTIFICATIONS
OPEN:WATCHFACE
OPEN:MENU
OPEN:HEALTH
OPEN:BRIGHTNESS
OPEN:FOCUS
OPEN:ABOUT
OPEN:VAULT
OPEN:MACRO
ACT:PLAY_PAUSE
ACT:NEXT_TRACK
ACT:PREV_TRACK
ACT:VOL_UP
ACT:VOL_DOWN

Reply ONLY with the tag (e.g. OPEN:SETTINGS). If unknown, reply UNKNOWN.`
          },
          {
            role: 'user',
            content: utterance
          }
        ]
      })
    });

    if (!resp.ok) return null;
    const data = await resp.json();
    const tag = data.choices?.[0]?.message?.content?.trim();
    return tag && tag !== 'UNKNOWN' ? tag : null;
  } catch (e) {
    return null;
  }
}

/**
 * Text Question Answering via Groq LLM (openai/gpt-oss-20b)
 */
export async function askGroqLLM(question, apiKey) {
  const cleanKey = (apiKey || '').trim();
  if (!cleanKey) {
    throw new Error('Groq API Key is missing! Click ⚙️ Settings in the top-right and paste your Groq key.');
  }

  const t0 = performance.now();
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cleanKey}`,
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
  const cleanKey = (apiKey || '').trim();
  if (!cleanKey) {
    throw new Error('Groq API Key is missing! Click ⚙️ Settings in the top-right and paste your Groq key.');
  }

  const t0 = performance.now();
  const prompt = customPrompt && customPrompt.trim().length > 0
    ? customPrompt.trim()
    : 'Read and extract all visible text from this image, then explain or answer clearly.';

  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cleanKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'qwen/qwen3.8-27b',
      messages: [
        {
          role: 'system',
          content: 'You are an AI smartwatch assistant. Inspect the attached image carefully and answer the user question directly in 1-2 punchy sentences. State what is visible in the image. Do not use filler preamble like "Based on the image...".'
        },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`
              }
            },
            {
              type: 'text',
              text: prompt
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
