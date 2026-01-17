/**
 * OpenAI Response Converter
 * Converts Anthropic Messages API responses to OpenAI Chat Completions API format
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
 * Convert Anthropic Messages API response to OpenAI Chat Completions API format
 *
 * @param {Object} anthropicResponse - Anthropic format response
 * @param {string} model - The model name used
 * @param {boolean} includeThinking - Whether to include thinking blocks as text
 * @returns {Object} OpenAI format response
 */
export function convertAnthropicToOpenAI(anthropicResponse, model, includeThinking = false) {
    const content = anthropicResponse.content || [];

    // Extract text content (optionally including thinking)
    const textParts = [];
    const toolCalls = [];
    let toolCallIndex = 0;

    for (const block of content) {
        if (block.type === 'text') {
            textParts.push(block.text);
        } else if (block.type === 'thinking' && includeThinking) {
            // Include thinking as text with markers
            textParts.push(`<thinking>\n${block.thinking}\n</thinking>`);
        } else if (block.type === 'tool_use') {
            toolCalls.push({
                id: block.id,
                type: 'function',
                function: {
                    name: block.name,
                    arguments: JSON.stringify(block.input || {})
                },
                index: toolCallIndex++
            });
        }
    }

    // Build message object
    const message = {
        role: 'assistant',
        content: textParts.length > 0 ? textParts.join('\n') : null
    };

    // Add tool_calls if present
    if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
    }

    // Map stop reason
    const finishReason = STOP_REASON_MAP[anthropicResponse.stop_reason] || 'stop';

    // Build usage object
    const usage = anthropicResponse.usage || {};
    const promptTokens = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0);
    const completionTokens = usage.output_tokens || 0;

    // Generate response ID
    const responseId = anthropicResponse.id
        ? `chatcmpl-${anthropicResponse.id.replace('msg_', '')}`
        : `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;

    return {
        id: responseId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
            index: 0,
            message: message,
            logprobs: null,
            finish_reason: finishReason
        }],
        usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens
        },
        system_fingerprint: null
    };
}

/**
 * Convert Anthropic error response to OpenAI error format
 *
 * @param {Object} anthropicError - Anthropic error object
 * @param {number} statusCode - HTTP status code
 * @returns {Object} OpenAI format error
 */
export function convertAnthropicErrorToOpenAI(anthropicError, statusCode) {
    const errorType = anthropicError.error?.type || 'api_error';
    const errorMessage = anthropicError.error?.message || 'An error occurred';

    // Map Anthropic error types to OpenAI error types
    const errorTypeMap = {
        'authentication_error': 'invalid_api_key',
        'invalid_request_error': 'invalid_request_error',
        'rate_limit_error': 'rate_limit_exceeded',
        'api_error': 'api_error',
        'overloaded_error': 'server_error',
        'permission_error': 'insufficient_quota'
    };

    return {
        error: {
            message: errorMessage,
            type: errorTypeMap[errorType] || 'api_error',
            param: null,
            code: statusCode === 401 ? 'invalid_api_key' :
                  statusCode === 429 ? 'rate_limit_exceeded' :
                  statusCode === 400 ? 'invalid_request_error' : null
        }
    };
}
