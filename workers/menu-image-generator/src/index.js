const DEFAULT_TEXT_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';
const DEFAULT_IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function normalizeText(value, maxLength = 1200) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function readModelText(result) {
  return normalizeText(
    result?.response
    || result?.choices?.[0]?.message?.content
    || result?.result?.response
    || result?.result?.choices?.[0]?.message?.content
    || ''
  );
}

function cleanPrompt(text) {
  const cleaned = normalizeText(text, 420)
    .replace(/^["'`“”«»]+|["'`“”«»]+$/g, '')
    .replace(/^(prompt|image prompt|english prompt)\s*:\s*/i, '')
    .replace(/\b(on|with)\s+a\s+table\b/gi, '')
    .replace(/\bwooden\s+table\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned || 'healthy cooked meal on a white plate';
}

function completeFoodPrompt(prompt) {
  const base = cleanPrompt(prompt);
  const additions = [
    'photorealistic cooked food',
    'centered product food photography',
    'isolated on pure white background',
    'soft studio lighting',
    'no text',
    'no hands',
    'no people',
    'no table',
    'no logo',
    'no live animal'
  ];

  return `${base}, ${additions.join(', ')}`.replace(/\s+/g, ' ').trim();
}

async function buildImagePrompt(env, { recipe, blockName }) {
  const textModel = env.TEXT_MODEL || DEFAULT_TEXT_MODEL;
  const system = [
    'You are a strict food image prompt generator.',
    'Convert Russian menu text into one short English image prompt for the exact prepared dish.',
    'Do not add ingredients that are not present in the user text.',
    'Do not turn chicken meat into a live chicken or animal.',
    'Do not invent bread unless the dish is a sandwich/toast/bread.',
    'Return only the English prompt, no quotes, no comments.'
  ].join(' ');

  const user = [
    `Menu block: ${normalizeText(blockName, 80) || 'dish'}`,
    `Dish text: ${normalizeText(recipe)}`
  ].join('\n');

  const result = await env.AI.run(textModel, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    max_tokens: 90
  });

  return {
    textModel,
    prompt: completeFoodPrompt(readModelText(result))
  };
}

function extractImageBase64(result) {
  if (!result) return '';
  if (typeof result.image === 'string') return result.image;
  if (Array.isArray(result.images) && typeof result.images[0] === 'string') return result.images[0];
  if (typeof result.result?.image === 'string') return result.result.image;
  if (Array.isArray(result.result?.images) && typeof result.result.images[0] === 'string') return result.result.images[0];
  if (typeof result === 'string') return result;
  return '';
}

async function generateImage(env, prompt) {
  const imageModel = env.IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
  const result = await env.AI.run(imageModel, {
    prompt,
    steps: 4
  });
  const imageBase64 = extractImageBase64(result);
  if (!imageBase64) {
    throw new Error('Модель не вернула картинку.');
  }

  return {
    imageModel,
    imageBase64
  };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({
        ok: true,
        textModel: env.TEXT_MODEL || DEFAULT_TEXT_MODEL,
        imageModel: env.IMAGE_MODEL || DEFAULT_IMAGE_MODEL
      });
    }

    if (request.method !== 'POST' || url.pathname !== '/generate') {
      return json({ ok: false, error: 'Use POST /generate' }, 404);
    }

    try {
      const body = await request.json();
      const recipe = normalizeText(body.recipe);
      const blockName = normalizeText(body.blockName, 80);

      if (!recipe) {
        return json({ ok: false, error: 'Нужен текст рецепта или описания блюда.' }, 400);
      }

      const promptResult = await buildImagePrompt(env, { recipe, blockName });
      const imageResult = await generateImage(env, promptResult.prompt);

      return json({
        ok: true,
        prompt: promptResult.prompt,
        promptSource: 'cloudflare-workers-ai',
        textModel: promptResult.textModel,
        imageModel: imageResult.imageModel,
        image: {
          mimeType: 'image/jpeg',
          base64: imageResult.imageBase64
        }
      });
    } catch (error) {
      return json({
        ok: false,
        error: error?.message || String(error)
      }, 500);
    }
  }
};
