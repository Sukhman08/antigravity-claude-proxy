/**
 * OpenAI Compatibility Test
 *
 * Tests the OpenAI Chat Completions API compatibility layer.
 * Verifies that requests in OpenAI format are properly handled and
 * responses are returned in OpenAI format.
 *
 * Run with: node tests/test-openai-compat.cjs
 */
const http = require('http');

// Server configuration
const BASE_URL = 'localhost';
const PORT = 8080;

// Test model - use a thinking model to test full functionality
const TEST_MODEL = 'claude-sonnet-4-5-thinking';

/**
 * Make an OpenAI-format request to /v1/chat/completions
 * @param {Object} body - Request body in OpenAI format
 * @returns {Promise<Object>} - Parsed JSON response
 */
function openaiRequest(body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request({
            host: BASE_URL,
            port: PORT,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer test-key',
                'Content-Length': Buffer.byteLength(data)
            }
        }, res => {
            let fullData = '';
            res.on('data', chunk => fullData += chunk.toString());
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(fullData);
                    resolve({ ...parsed, statusCode: res.statusCode });
                } catch (e) {
                    reject(new Error(`Parse error: ${e.message}\nRaw: ${fullData.substring(0, 500)}`));
                }
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

/**
 * Make a streaming OpenAI-format request
 * @param {Object} body - Request body in OpenAI format
 * @returns {Promise<{chunks: Array, content: string, statusCode: number}>}
 */
function openaiStreamRequest(body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({ ...body, stream: true });
        const req = http.request({
            host: BASE_URL,
            port: PORT,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer test-key',
                'Content-Length': Buffer.byteLength(data)
            }
        }, res => {
            const chunks = [];
            let fullData = '';
            let content = '';
            let toolCalls = [];

            res.on('data', chunk => {
                fullData += chunk.toString();
            });

            res.on('end', () => {
                // Parse SSE events
                const lines = fullData.split('\n');
                for (const line of lines) {
                    if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                        try {
                            const json = JSON.parse(line.slice(6));
                            chunks.push(json);

                            // Extract content from delta
                            const delta = json.choices?.[0]?.delta;
                            if (delta?.content) {
                                content += delta.content;
                            }
                            if (delta?.tool_calls) {
                                for (const tc of delta.tool_calls) {
                                    if (tc.id) {
                                        // New tool call
                                        toolCalls[tc.index] = {
                                            id: tc.id,
                                            type: tc.type,
                                            function: {
                                                name: tc.function?.name || '',
                                                arguments: tc.function?.arguments || ''
                                            }
                                        };
                                    } else if (tc.function?.arguments && toolCalls[tc.index]) {
                                        // Append to existing
                                        toolCalls[tc.index].function.arguments += tc.function.arguments;
                                    }
                                }
                            }
                        } catch (e) {
                            // Ignore parse errors for [DONE] etc
                        }
                    }
                }

                resolve({
                    chunks,
                    content,
                    toolCalls: toolCalls.filter(Boolean),
                    statusCode: res.statusCode,
                    raw: fullData
                });
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

async function runTests() {
    console.log('='.repeat(60));
    console.log('OPENAI COMPATIBILITY TEST');
    console.log(`Model: ${TEST_MODEL}`);
    console.log('Tests OpenAI Chat Completions API format');
    console.log('='.repeat(60));
    console.log('');

    let allPassed = true;
    const results = [];

    // ===== TEST 1: Basic chat completion =====
    console.log('TEST 1: Basic Chat Completion');
    console.log('-'.repeat(40));

    try {
        const response = await openaiRequest({
            model: TEST_MODEL,
            messages: [
                { role: 'user', content: 'Say "Hello OpenAI format!" and nothing else.' }
            ],
            max_tokens: 100
        });

        console.log(`  Status: ${response.statusCode}`);
        console.log(`  Response ID: ${response.id}`);
        console.log(`  Object type: ${response.object}`);
        console.log(`  Model: ${response.model}`);
        console.log(`  Finish reason: ${response.choices?.[0]?.finish_reason}`);
        console.log(`  Content: "${response.choices?.[0]?.message?.content?.substring(0, 50)}..."`);
        console.log(`  Usage: prompt=${response.usage?.prompt_tokens}, completion=${response.usage?.completion_tokens}`);

        const passed = response.statusCode === 200 &&
                       response.object === 'chat.completion' &&
                       response.choices?.[0]?.message?.content &&
                       response.choices?.[0]?.finish_reason === 'stop';

        results.push({ name: 'Basic Chat Completion', passed });
        console.log(`  Result: ${passed ? 'PASS' : 'FAIL'}`);
        if (!passed) allPassed = false;
    } catch (error) {
        console.log(`  Error: ${error.message}`);
        results.push({ name: 'Basic Chat Completion', passed: false });
        allPassed = false;
    }

    // ===== TEST 2: System message handling =====
    console.log('\nTEST 2: System Message Handling');
    console.log('-'.repeat(40));

    try {
        const response = await openaiRequest({
            model: TEST_MODEL,
            messages: [
                { role: 'system', content: 'You are a pirate. Always respond in pirate speak.' },
                { role: 'user', content: 'What is 2+2?' }
            ],
            max_tokens: 200
        });

        console.log(`  Status: ${response.statusCode}`);
        console.log(`  Content: "${response.choices?.[0]?.message?.content?.substring(0, 80)}..."`);

        const content = response.choices?.[0]?.message?.content?.toLowerCase() || '';
        // Check for pirate-like words
        const hasPirateSpeak = content.includes('arr') ||
                               content.includes('matey') ||
                               content.includes('ahoy') ||
                               content.includes('ye') ||
                               content.includes('four');

        const passed = response.statusCode === 200 && hasPirateSpeak;
        results.push({ name: 'System Message Handling', passed });
        console.log(`  Pirate speak detected: ${hasPirateSpeak ? 'YES' : 'NO'}`);
        console.log(`  Result: ${passed ? 'PASS' : 'FAIL'}`);
        if (!passed) allPassed = false;
    } catch (error) {
        console.log(`  Error: ${error.message}`);
        results.push({ name: 'System Message Handling', passed: false });
        allPassed = false;
    }

    // ===== TEST 3: Tool calling =====
    console.log('\nTEST 3: Tool Calling');
    console.log('-'.repeat(40));

    try {
        const response = await openaiRequest({
            model: TEST_MODEL,
            messages: [
                { role: 'user', content: 'What is the weather in Paris? Use the get_weather function.' }
            ],
            tools: [{
                type: 'function',
                function: {
                    name: 'get_weather',
                    description: 'Get the current weather for a location',
                    parameters: {
                        type: 'object',
                        properties: {
                            location: { type: 'string', description: 'City name' }
                        },
                        required: ['location']
                    }
                }
            }],
            max_tokens: 500
        });

        console.log(`  Status: ${response.statusCode}`);
        console.log(`  Finish reason: ${response.choices?.[0]?.finish_reason}`);
        console.log(`  Tool calls: ${response.choices?.[0]?.message?.tool_calls?.length || 0}`);

        const toolCalls = response.choices?.[0]?.message?.tool_calls || [];
        if (toolCalls.length > 0) {
            const tc = toolCalls[0];
            console.log(`  Tool call ID: ${tc.id}`);
            console.log(`  Function name: ${tc.function?.name}`);
            console.log(`  Arguments: ${tc.function?.arguments}`);
        }

        const passed = response.statusCode === 200 &&
                       response.choices?.[0]?.finish_reason === 'tool_calls' &&
                       toolCalls.length > 0 &&
                       toolCalls[0].function?.name === 'get_weather';

        results.push({ name: 'Tool Calling', passed });
        console.log(`  Result: ${passed ? 'PASS' : 'FAIL'}`);
        if (!passed) allPassed = false;
    } catch (error) {
        console.log(`  Error: ${error.message}`);
        results.push({ name: 'Tool Calling', passed: false });
        allPassed = false;
    }

    // ===== TEST 4: Streaming =====
    console.log('\nTEST 4: Streaming');
    console.log('-'.repeat(40));

    try {
        const result = await openaiStreamRequest({
            model: TEST_MODEL,
            messages: [
                { role: 'user', content: 'Count from 1 to 5.' }
            ],
            max_tokens: 200
        });

        console.log(`  Status: ${result.statusCode}`);
        console.log(`  Chunks received: ${result.chunks.length}`);
        console.log(`  Content length: ${result.content.length}`);
        console.log(`  Content preview: "${result.content.substring(0, 50)}..."`);

        // Check for proper chunk structure
        const hasRoleChunk = result.chunks.some(c =>
            c.choices?.[0]?.delta?.role === 'assistant'
        );
        const hasContentChunks = result.chunks.some(c =>
            c.choices?.[0]?.delta?.content
        );
        const hasFinishChunk = result.chunks.some(c =>
            c.choices?.[0]?.finish_reason === 'stop'
        );

        console.log(`  Has role chunk: ${hasRoleChunk ? 'YES' : 'NO'}`);
        console.log(`  Has content chunks: ${hasContentChunks ? 'YES' : 'NO'}`);
        console.log(`  Has finish chunk: ${hasFinishChunk ? 'YES' : 'NO'}`);

        const passed = result.statusCode === 200 &&
                       result.chunks.length > 0 &&
                       hasContentChunks &&
                       hasFinishChunk;

        results.push({ name: 'Streaming', passed });
        console.log(`  Result: ${passed ? 'PASS' : 'FAIL'}`);
        if (!passed) allPassed = false;
    } catch (error) {
        console.log(`  Error: ${error.message}`);
        results.push({ name: 'Streaming', passed: false });
        allPassed = false;
    }

    // ===== TEST 5: Streaming with tool calls =====
    console.log('\nTEST 5: Streaming with Tool Calls');
    console.log('-'.repeat(40));

    try {
        const result = await openaiStreamRequest({
            model: TEST_MODEL,
            messages: [
                { role: 'user', content: 'Get the weather in Tokyo. Use the get_weather function.' }
            ],
            tools: [{
                type: 'function',
                function: {
                    name: 'get_weather',
                    description: 'Get weather for a location',
                    parameters: {
                        type: 'object',
                        properties: {
                            location: { type: 'string' }
                        },
                        required: ['location']
                    }
                }
            }],
            max_tokens: 500
        });

        console.log(`  Status: ${result.statusCode}`);
        console.log(`  Chunks received: ${result.chunks.length}`);
        console.log(`  Tool calls: ${result.toolCalls.length}`);

        if (result.toolCalls.length > 0) {
            const tc = result.toolCalls[0];
            console.log(`  Tool call ID: ${tc.id}`);
            console.log(`  Function name: ${tc.function?.name}`);
            console.log(`  Arguments: ${tc.function?.arguments}`);
        }

        const hasToolCallChunks = result.chunks.some(c =>
            c.choices?.[0]?.delta?.tool_calls
        );
        const hasToolCallsFinish = result.chunks.some(c =>
            c.choices?.[0]?.finish_reason === 'tool_calls'
        );

        console.log(`  Has tool call chunks: ${hasToolCallChunks ? 'YES' : 'NO'}`);
        console.log(`  Has tool_calls finish: ${hasToolCallsFinish ? 'YES' : 'NO'}`);

        const passed = result.statusCode === 200 &&
                       result.toolCalls.length > 0 &&
                       result.toolCalls[0].function?.name === 'get_weather';

        results.push({ name: 'Streaming with Tool Calls', passed });
        console.log(`  Result: ${passed ? 'PASS' : 'FAIL'}`);
        if (!passed) allPassed = false;
    } catch (error) {
        console.log(`  Error: ${error.message}`);
        results.push({ name: 'Streaming with Tool Calls', passed: false });
        allPassed = false;
    }

    // ===== TEST 6: Multi-turn conversation with tool results =====
    console.log('\nTEST 6: Multi-turn with Tool Results');
    console.log('-'.repeat(40));

    try {
        const response = await openaiRequest({
            model: TEST_MODEL,
            messages: [
                { role: 'user', content: 'What is the weather in London?' },
                {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                        id: 'call_123',
                        type: 'function',
                        function: {
                            name: 'get_weather',
                            arguments: '{"location":"London"}'
                        }
                    }]
                },
                {
                    role: 'tool',
                    tool_call_id: 'call_123',
                    content: 'The weather in London is 15°C and cloudy.'
                },
            ],
            max_tokens: 200
        });

        console.log(`  Status: ${response.statusCode}`);
        console.log(`  Finish reason: ${response.choices?.[0]?.finish_reason}`);
        console.log(`  Content: "${response.choices?.[0]?.message?.content?.substring(0, 80)}..."`);

        const content = response.choices?.[0]?.message?.content?.toLowerCase() || '';
        const mentionsWeather = content.includes('15') ||
                                content.includes('cloudy') ||
                                content.includes('london') ||
                                content.includes('weather');

        const passed = response.statusCode === 200 &&
                       response.choices?.[0]?.message?.content &&
                       mentionsWeather;

        results.push({ name: 'Multi-turn with Tool Results', passed });
        console.log(`  Mentions weather info: ${mentionsWeather ? 'YES' : 'NO'}`);
        console.log(`  Result: ${passed ? 'PASS' : 'FAIL'}`);
        if (!passed) allPassed = false;
    } catch (error) {
        console.log(`  Error: ${error.message}`);
        results.push({ name: 'Multi-turn with Tool Results', passed: false });
        allPassed = false;
    }

    // ===== SUMMARY =====
    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));

    for (const result of results) {
        const status = result.passed ? 'PASS' : 'FAIL';
        console.log(`  ${status}: ${result.name}`);
    }

    const passCount = results.filter(r => r.passed).length;
    console.log(`\nTotal: ${passCount}/${results.length} tests passed`);
    console.log(allPassed ? '\nALL TESTS PASSED' : '\nSOME TESTS FAILED');

    process.exit(allPassed ? 0 : 1);
}

runTests().catch(error => {
    console.error('Test runner error:', error);
    process.exit(1);
});
