/**
 * OpenAI Streaming Converter
 * Converts Anthropic SSE events to OpenAI streaming format
 */

import crypto from 'crypto';

/**
 * Map Anthropic stop_reason to OpenAI finish_reason
 */
const STOP_REASON_MAP = {
    'end_turn': 'stop',
    'stop_sequence': 'stop',
    'max_tokens': 'length',
    'tool_use': 'tool_calls'
};

/**
 * Convert Anthropic SSE stream to OpenAI streaming format
 *
 * This generator transforms Anthropic's event-based streaming format
 * to OpenAI's delta-based streaming format.
 *
 * @param {AsyncIterable} anthropicStream - Anthropic SSE events generator
 * @param {string} model - The model name
 * @param {boolean} includeThinking - Whether to include thinking blocks as text
 * @yields {string} OpenAI SSE formatted strings (ready to write to response)
 */
export async function* streamOpenAIResponse(anthropicStream, model, includeThinking = false) {
    const responseId = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
    const created = Math.floor(Date.now() / 1000);

    let currentToolCallIndex = -1;
    let currentToolCallId = null;
    let inThinkingBlock = false;
    let sentInitialChunk = false;
    let finishReason = null;

    for await (const event of anthropicStream) {
        const chunks = convertEvent(event, {
            responseId,
            created,
            model,
            includeThinking,
            currentToolCallIndex,
            currentToolCallId,
            inThinkingBlock,
            sentInitialChunk
        });

        for (const chunk of chunks) {
            // Update state based on chunk
            if (chunk._updateState) {
                if (chunk._updateState.currentToolCallIndex !== undefined) {
                    currentToolCallIndex = chunk._updateState.currentToolCallIndex;
                }
                if (chunk._updateState.currentToolCallId !== undefined) {
                    currentToolCallId = chunk._updateState.currentToolCallId;
                }
                if (chunk._updateState.inThinkingBlock !== undefined) {
                    inThinkingBlock = chunk._updateState.inThinkingBlock;
                }
                if (chunk._updateState.sentInitialChunk !== undefined) {
                    sentInitialChunk = chunk._updateState.sentInitialChunk;
                }
                if (chunk._updateState.finishReason !== undefined) {
                    finishReason = chunk._updateState.finishReason;
                }
                delete chunk._updateState;
            }

            // Skip empty chunks
            if (chunk._skip) continue;

            yield `data: ${JSON.stringify(chunk)}\n\n`;
        }
    }

    // Send final chunk with finish_reason
    const finalChunk = {
        id: responseId,
        object: 'chat.completion.chunk',
        created: created,
        model: model,
        choices: [{
            index: 0,
            delta: {},
            logprobs: null,
            finish_reason: finishReason || 'stop'
        }],
        system_fingerprint: null
    };

    yield `data: ${JSON.stringify(finalChunk)}\n\n`;
    yield 'data: [DONE]\n\n';
}

/**
 * Convert a single Anthropic event to OpenAI chunk(s)
 * @param {Object} event - Anthropic SSE event
 * @param {Object} state - Current streaming state
 * @returns {Array} Array of OpenAI chunks (may be empty)
 */
function convertEvent(event, state) {
    const { responseId, created, model, includeThinking } = state;
    const chunks = [];

    const baseChunk = {
        id: responseId,
        object: 'chat.completion.chunk',
        created: created,
        model: model,
        system_fingerprint: null
    };

    switch (event.type) {
        case 'message_start':
            // Send initial empty chunk to establish connection
            chunks.push({
                ...baseChunk,
                choices: [{
                    index: 0,
                    delta: { role: 'assistant', content: '' },
                    logprobs: null,
                    finish_reason: null
                }],
                _updateState: { sentInitialChunk: true }
            });
            break;

        case 'content_block_start':
            const blockType = event.content_block?.type;

            if (blockType === 'thinking') {
                if (includeThinking) {
                    // Start thinking block with marker
                    chunks.push({
                        ...baseChunk,
                        choices: [{
                            index: 0,
                            delta: { content: '<thinking>\n' },
                            logprobs: null,
                            finish_reason: null
                        }],
                        _updateState: { inThinkingBlock: true }
                    });
                } else {
                    chunks.push({ _skip: true, _updateState: { inThinkingBlock: true } });
                }
            } else if (blockType === 'tool_use') {
                const newIndex = state.currentToolCallIndex + 1;
                const toolBlock = event.content_block;

                chunks.push({
                    ...baseChunk,
                    choices: [{
                        index: 0,
                        delta: {
                            tool_calls: [{
                                index: newIndex,
                                id: toolBlock.id,
                                type: 'function',
                                function: {
                                    name: toolBlock.name,
                                    arguments: ''
                                }
                            }]
                        },
                        logprobs: null,
                        finish_reason: null
                    }],
                    _updateState: {
                        currentToolCallIndex: newIndex,
                        currentToolCallId: toolBlock.id
                    }
                });
            }
            // text blocks don't need special handling at start
            break;

        case 'content_block_delta':
            const deltaType = event.delta?.type;

            if (deltaType === 'thinking_delta') {
                if (includeThinking && state.inThinkingBlock) {
                    chunks.push({
                        ...baseChunk,
                        choices: [{
                            index: 0,
                            delta: { content: event.delta.thinking || '' },
                            logprobs: null,
                            finish_reason: null
                        }]
                    });
                }
            } else if (deltaType === 'text_delta') {
                chunks.push({
                    ...baseChunk,
                    choices: [{
                        index: 0,
                        delta: { content: event.delta.text || '' },
                        logprobs: null,
                        finish_reason: null
                    }]
                });
            } else if (deltaType === 'input_json_delta') {
                if (state.currentToolCallIndex >= 0) {
                    chunks.push({
                        ...baseChunk,
                        choices: [{
                            index: 0,
                            delta: {
                                tool_calls: [{
                                    index: state.currentToolCallIndex,
                                    function: {
                                        arguments: event.delta.partial_json || ''
                                    }
                                }]
                            },
                            logprobs: null,
                            finish_reason: null
                        }]
                    });
                }
            }
            // signature_delta is ignored (OpenAI has no equivalent)
            break;

        case 'content_block_stop':
            if (state.inThinkingBlock && includeThinking) {
                chunks.push({
                    ...baseChunk,
                    choices: [{
                        index: 0,
                        delta: { content: '\n</thinking>\n' },
                        logprobs: null,
                        finish_reason: null
                    }],
                    _updateState: { inThinkingBlock: false }
                });
            } else {
                chunks.push({ _skip: true, _updateState: { inThinkingBlock: false } });
            }
            break;

        case 'message_delta':
            // Capture finish reason for final chunk
            const stopReason = event.delta?.stop_reason;
            if (stopReason) {
                chunks.push({
                    _skip: true,
                    _updateState: { finishReason: STOP_REASON_MAP[stopReason] || 'stop' }
                });
            }
            break;

        case 'message_stop':
            // Handled by the final chunk after the loop
            break;

        case 'error':
            // Convert error to OpenAI format
            chunks.push({
                ...baseChunk,
                choices: [{
                    index: 0,
                    delta: {},
                    logprobs: null,
                    finish_reason: 'stop'
                }],
                error: {
                    message: event.error?.message || 'An error occurred',
                    type: 'api_error'
                }
            });
            break;
    }

    return chunks;
}

/**
 * Write SSE stream in OpenAI format to Express response
 * Helper function for server.js
 *
 * @param {Response} res - Express response object
 * @param {AsyncIterable} anthropicStream - Anthropic SSE events generator
 * @param {string} model - The model name
 * @param {boolean} includeThinking - Whether to include thinking blocks
 */
export async function writeOpenAIStream(res, anthropicStream, model, includeThinking = false) {
    for await (const chunk of streamOpenAIResponse(anthropicStream, model, includeThinking)) {
        res.write(chunk);
        if (res.flush) res.flush();
    }
}
