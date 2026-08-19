/**
 * test-gemini-client.mjs
 *
 * Exercises the Gemini client against a stand-in server that mimics a
 * Gemini-compatible backend, so the parts that cannot be tested against the real
 * API get covered: base-URL routing, auth headers, structured output, thinking
 * config, the retry that simplifies a rejected request, model listing, and the
 * errors for a retired or unavailable model.
 *
 * Usage: node scripts/test-gemini-client.mjs
 */

import http from 'node:http';
import {
  callGeminiApi,
  listAvailableModels,
  verifyGeminiAccess,
  retirementNoteFor,
  DEFAULT_GEMINI_MODEL,
  GOOGLE_API_BASE
} from '../src/gemini.js';
import { V2_COMPOSITION_SCHEMA } from '../src/caption-utils.js';

const KEY = 'test-key-123';
const problems = [];

function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(label);
}

const SAMPLE_REPLY = JSON.stringify({
  compositions: [
    { token_ids: [1, 2, 3], hero_token_id: 2, comp_type: 'emphasis', cleaned_texts: { 3: 'insane' } }
  ]
});

/**
 * @param {object} behaviour
 *  rejectSchema  – 400 when responseJsonSchema is present
 *  rejectThinking – 400 when thinkingConfig is present
 *  status        – force a status code
 */
function startMockServer(behaviour = {}) {
  const seen = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString() || '{}';
      let body = {};
      try { body = JSON.parse(bodyText); } catch { /* leave empty */ }

      seen.push({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body
      });

      const send = (code, payload) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      // Auth, the same order AIStudioToAPI checks in.
      const key = req.headers['x-goog-api-key']
        || (req.headers.authorization || '').replace(/^Bearer /, '')
        || req.headers['x-api-key'];
      if (key !== KEY) return send(401, { error: { message: 'Invalid API key' } });

      if (req.method === 'GET' && req.url.startsWith('/v1beta/models')) {
        return send(200, {
          models: [
            { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }
          ]
        });
      }

      const match = req.url.match(/\/v1beta\/models\/([^:]+):generateContent/);
      if (req.method === 'POST' && match) {
        const model = decodeURIComponent(match[1]);
        if (behaviour.status) return send(behaviour.status, { error: { message: 'forced failure' } });
        if (model === 'no-such-model') return send(404, { error: { message: 'model not found' } });

        const config = body.generationConfig || {};
        if (behaviour.rejectSchema && config.responseJsonSchema) {
          return send(400, { error: { message: 'Unknown name "responseJsonSchema"' } });
        }
        if (behaviour.rejectThinking && config.thinkingConfig) {
          return send(400, { error: { message: 'Unknown name "thinkingConfig"' } });
        }

        return send(200, {
          candidates: [{
            content: {
              parts: [
                { text: 'internal reasoning that must be ignored', thought: true },
                { text: SAMPLE_REPLY }
              ]
            },
            finishReason: 'STOP'
          }],
          usageMetadata: { promptTokenCount: 1234, candidatesTokenCount: 56 }
        });
      }

      send(404, { error: { message: 'not found' } });
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, seen, base: `http://127.0.0.1:${port}/v1beta` });
    });
  });
}

async function main() {
  console.log('Gemini client against a stand-in Gemini-compatible backend\n');

  // 1. Happy path through a proxy base URL
  {
    const { server, seen, base } = await startMockServer();
    const result = await callGeminiApi('prompt here', {
      apiKey: KEY, model: 'gemini-3.5-flash', base, schema: V2_COMPOSITION_SCHEMA
    });
    const request = seen.find(r => r.method === 'POST');

    check('reaches a custom base URL', request?.url === '/v1beta/models/gemini-3.5-flash:generateContent', request?.url);
    check('sends the x-goog-api-key header', request?.headers['x-goog-api-key'] === KEY);
    check('also sends Bearer auth to a proxy', request?.headers.authorization === `Bearer ${KEY}`);
    check('asks for JSON output', request?.body?.generationConfig?.responseMimeType === 'application/json');
    check('sends the response schema', !!request?.body?.generationConfig?.responseJsonSchema);
    check('pins thinking low for Gemini 3',
      request?.body?.generationConfig?.thinkingConfig?.thinkingLevel === 'low',
      JSON.stringify(request?.body?.generationConfig?.thinkingConfig));
    check('does not set temperature',
      request?.body?.generationConfig?.temperature === undefined,
      `got ${request?.body?.generationConfig?.temperature}`);
    check('ignores thought parts in the reply', result.text === SAMPLE_REPLY);
    check('reports token usage', result.usage?.promptTokenCount === 1234);
    server.close();
  }

  // 2. A backend that rejects the schema should still succeed
  {
    const { server, seen, base } = await startMockServer({ rejectSchema: true });
    const result = await callGeminiApi('prompt', {
      apiKey: KEY, model: 'gemini-3.5-flash', base, schema: V2_COMPOSITION_SCHEMA
    });
    const posts = seen.filter(r => r.method === 'POST');
    check('retries without the schema when it is rejected', posts.length === 2, `${posts.length} attempts`);
    check('the retry drops responseJsonSchema',
      posts[1] && !posts[1].body.generationConfig.responseJsonSchema);
    check('still returns usable text after degrading', result.text === SAMPLE_REPLY);
    check('reports that it degraded', !!result.degraded, result.degraded || '');
    server.close();
  }

  // 3. A backend that also rejects thinking config
  {
    const { server, seen, base } = await startMockServer({ rejectSchema: true, rejectThinking: true });
    const result = await callGeminiApi('prompt', {
      apiKey: KEY, model: 'gemini-3.5-flash', base, schema: V2_COMPOSITION_SCHEMA
    });
    const posts = seen.filter(r => r.method === 'POST');
    check('falls all the way back to a plain request', posts.length === 3, `${posts.length} attempts`);
    check('plain request carries neither extra', posts[2]
      && !posts[2].body.generationConfig.responseJsonSchema
      && !posts[2].body.generationConfig.thinkingConfig);
    check('plain request still succeeds', result.text === SAMPLE_REPLY);
    server.close();
  }

  // 4. Errors that must not be retried
  {
    const { server, seen, base } = await startMockServer();
    let message = '';
    try {
      await callGeminiApi('p', { apiKey: KEY, model: 'no-such-model', base });
    } catch (err) {
      message = err.message;
    }
    const posts = seen.filter(r => r.method === 'POST');
    check('a missing model fails immediately', posts.length === 1, `${posts.length} attempts`);
    check('the missing-model error names the model', message.includes('no-such-model'), message);
    check('it points at the doctor script for a proxy', message.includes('gemini:doctor'), message);
    server.close();
  }

  {
    const { server, seen, base } = await startMockServer({ status: 429 });
    let message = '';
    try {
      await callGeminiApi('p', { apiKey: KEY, model: 'gemini-3.5-flash', base });
    } catch (err) {
      message = err.message;
    }
    check('a rate limit is not retried', seen.filter(r => r.method === 'POST').length === 1);
    check('the rate limit error is surfaced', message.length > 0, message);
    server.close();
  }

  // 5. Wrong key
  {
    const { server, base } = await startMockServer();
    let message = '';
    try {
      await callGeminiApi('p', { apiKey: 'wrong', model: 'gemini-3.5-flash', base });
    } catch (err) {
      message = err.message;
    }
    check('a bad key is reported', /Invalid API key/i.test(message), message);
    server.close();
  }

  // 6. Model listing and access verification
  {
    const { server, base } = await startMockServer();
    const models = await listAvailableModels(KEY, base);
    check('lists only models that can generate content',
      models.includes('gemini-3.5-flash') && !models.includes('text-embedding-004'),
      models.join(', '));

    const good = await verifyGeminiAccess(KEY, 'gemini-3.5-flash', base);
    check('verifies an available model', good.ok && good.backend === 'proxy');

    const bad = await verifyGeminiAccess(KEY, 'gemini-9-turbo', base);
    check('rejects an unavailable model', !bad.ok, bad.reason);
    check('suggests one that is available', /gemini-3\.5-flash/.test(bad.reason || ''), bad.reason);

    // A name retired on Google's API may still exist behind a proxy, so the
    // proxy path must not refuse it outright.
    const viaProxy = await verifyGeminiAccess(KEY, 'gemini-2.5-flash-lite', base);
    check('allows a Google-retired name when using a proxy', viaProxy.ok, viaProxy.reason || 'ok');
    server.close();
  }

  // 7. Retired models are refused against Google's own API
  {
    check('knows gemini-2.0-flash is retired', !!retirementNoteFor('gemini-2.0-flash'),
      retirementNoteFor('gemini-2.0-flash') || 'not flagged');

    let message = '';
    try {
      await callGeminiApi('p', { apiKey: KEY, model: 'gemini-2.0-flash', base: GOOGLE_API_BASE });
    } catch (err) {
      message = err.message;
    }
    check('refuses a retired model before making a request', /retired/i.test(message), message);
    check('the refusal suggests the current default',
      message.includes(DEFAULT_GEMINI_MODEL), message);
  }

  // 8. Unreachable proxy gives an actionable message
  {
    let message = '';
    try {
      await callGeminiApi('p', { apiKey: KEY, model: 'gemini-3.5-flash', base: 'http://127.0.0.1:1/v1beta' });
    } catch (err) {
      message = err.message;
    }
    check('an unreachable proxy says so', /proxy|running/i.test(message), message);
  }

  if (problems.length) {
    console.log(`\n${problems.length} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nGemini client OK.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
