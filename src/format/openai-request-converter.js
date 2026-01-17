/**
 * OpenAI Request Converter
 * Converts OpenAI Chat Completions API requests to Anthropic Messages API format
 */

import { logger } from '../utils/logger.js';

/**
 * Convert OpenAI Chat Completions request to Anthropic Messages API format
 *
 * @param {Object} openaiRequest - OpenAI format request
 * @returns {Object} Anthropic format request
 */
export function convertOpenAIToAnthropic(openaiRequest) {
    const {
        model,
        messages,
        max_tokens,
        max_completion_tokens,
        temperature,
        top_p,
        stop,
        stream,
        tools,
        tool_choice,
        // OpenAI-specific fields we'll handle or ignore
        frequency_penalty,
        presence_penalty,
        logprobs,
        top_logprobs,
        n,
        seed,
        response_format,
        user
    } = openaiRequest;

    // Extract system messages and convert to Anthropic system field
    const systemMessages = messages.filter(m => m.role === 'system');
    const system = systemMessages.length > 0
        ? systemMessages.map(m => extractTextContent(m.content)).join('\n\n')
        : undefined;

    // Convert non-system messages to Anthropic format
    const nonSystemMessages = messages.filter(m => m.role !== 'system');
    const anthropicMessages = convertMessages(nonSystemMessages);

    // Build Anthropic request
    const anthropicRequest = {
        model: model,
        messages: anthropicMessages,
        max_tokens: max_completion_tokens || max_tokens || 4096,
        stream: stream || false
    };

    // Add system if present
    if (system) {
        anthropicRequest.system = system;
    }

    // Add optional parameters
    if (temperature !== undefined) {
        anthropicRequest.temperature = temperature;
    }
    if (top_p !== undefined) {
        anthropicRequest.top_p = top_p;
    }
    if (stop) {
        anthropicRequest.stop_sequences = Array.isArray(stop) ? stop : [stop];
    }

    // Convert tools if present
    if (tools && tools.length > 0) {
        anthropicRequest.tools = convertTools(tools);
    }

    // Convert tool_choice if present
    if (tool_choice) {
        anthropicRequest.tool_choice = convertToolChoice(tool_choice);
    }

    // Enable thinking for thinking models (detected by model name)
    if (model && (model.includes('thinking') || model.includes('gemini-3'))) {
        anthropicRequest.thinking = { budget_tokens: 10000 };
    }

    // Log warnings for unsupported OpenAI-specific features
    if (logprobs || top_logprobs) {
        logger.debug('[OpenAI] logprobs not supported, ignoring');
    }
    if (n && n > 1) {
        logger.debug('[OpenAI] n > 1 not supported, using n=1');
    }
    if (response_format) {
        logger.debug('[OpenAI] response_format not directly supported, ignoring');
    }
    if (frequency_penalty || presence_penalty) {
        logger.debug('[OpenAI] frequency_penalty/presence_penalty not supported, ignoring');
    }

    return anthropicRequest;
}

/**
 * Extract text content from OpenAI message content (string or array)
 * @param {string|Array} content - Message content
 * @returns {string} Extracted text
 */
function extractTextContent(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .filter(part => part.type === 'text')
            .map(part => part.text)
            .join('');
    }
    return '';
}

/**
 * Convert OpenAI messages array to Anthropic format
 * @param {Array} messages - OpenAI messages
 * @returns {Array} Anthropic messages
 */
function convertMessages(messages) {
    const anthropicMessages = [];
    let pendingToolResults = [];

    for (const msg of messages) {
        if (msg.role === 'tool') {
            // Collect tool results to merge into a user message
            pendingToolResults.push({
                type: 'tool_result',
                tool_use_id: msg.tool_call_id,
                content: extractTextContent(msg.content)
            });
            continue;
        }

        // Flush pending tool results before adding new message
        if (pendingToolResults.length > 0 && msg.role !== 'tool') {
            anthropicMessages.push({
                role: 'user',
                content: pendingToolResults
            });
            pendingToolResults = [];
        }

        if (msg.role === 'user') {
            anthropicMessages.push({
                role: 'user',
                content: convertMessageContent(msg.content)
            });
        } else if (msg.role === 'assistant') {
            const content = convertAssistantMessage(msg);
            anthropicMessages.push({
                role: 'assistant',
                content: content
            });
        }
    }

    // Flush any remaining tool results
    if (pendingToolResults.length > 0) {
        anthropicMessages.push({
            role: 'user',
            content: pendingToolResults
        });
    }

    return anthropicMessages;
}

/**
 * Convert OpenAI message content to Anthropic format
 * @param {string|Array} content - OpenAI message content
 * @returns {Array|string} Anthropic message content
 */
function convertMessageContent(content) {
    if (typeof content === 'string') {
        return content;
    }

    if (!Array.isArray(content)) {
        return String(content);
    }

    const anthropicContent = [];

    for (const part of content) {
        if (part.type === 'text') {
            anthropicContent.push({
                type: 'text',
                text: part.text
            });
        } else if (part.type === 'image_url') {
            // Convert OpenAI image_url to Anthropic image format
            const imageUrl = part.image_url?.url || part.image_url;

            if (imageUrl.startsWith('data:')) {
                // Base64 data URL
                const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
                if (matches) {
                    anthropicContent.push({
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: matches[1],
                            data: matches[2]
                        }
                    });
                }
            } else {
                // URL reference - Anthropic supports URL images
                anthropicContent.push({
                    type: 'image',
                    source: {
                        type: 'url',
                        url: imageUrl
                    }
                });
            }
        }
    }

    return anthropicContent.length === 1 && anthropicContent[0].type === 'text'
        ? anthropicContent[0].text
        : anthropicContent;
}

/**
 * Convert OpenAI assistant message to Anthropic format
 * Handles tool_calls in assistant messages
 * @param {Object} msg - OpenAI assistant message
 * @returns {Array} Anthropic content array
 */
function convertAssistantMessage(msg) {
    const content = [];

    // Add text content if present
    if (msg.content) {
        const text = extractTextContent(msg.content);
        if (text) {
            content.push({
                type: 'text',
                text: text
            });
        }
    }

    // Convert tool_calls to tool_use blocks
    if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const toolCall of msg.tool_calls) {
            if (toolCall.type === 'function') {
                let args = {};
                try {
                    args = JSON.parse(toolCall.function.arguments || '{}');
                } catch (e) {
                    logger.warn('[OpenAI] Failed to parse tool call arguments:', e.message);
                }

                content.push({
                    type: 'tool_use',
                    id: toolCall.id,
                    name: toolCall.function.name,
                    input: args
                });
            }
        }
    }

    // Return string if only text content
    if (content.length === 1 && content[0].type === 'text') {
        return content[0].text;
    }

    return content.length > 0 ? content : '';
}

/**
 * Convert OpenAI tools to Anthropic format
 * @param {Array} tools - OpenAI tools array
 * @returns {Array} Anthropic tools array
 */
function convertTools(tools) {
    return tools.map(tool => {
        if (tool.type === 'function') {
            return {
                name: tool.function.name,
                description: tool.function.description || '',
                input_schema: tool.function.parameters || { type: 'object' }
            };
        }
        // Handle direct function definition (non-standard but sometimes used)
        return {
            name: tool.name || tool.function?.name,
            description: tool.description || tool.function?.description || '',
            input_schema: tool.parameters || tool.function?.parameters || { type: 'object' }
        };
    });
}

/**
 * Convert OpenAI tool_choice to Anthropic format
 * @param {string|Object} toolChoice - OpenAI tool_choice
 * @returns {Object} Anthropic tool_choice
 */
function convertToolChoice(toolChoice) {
    if (typeof toolChoice === 'string') {
        if (toolChoice === 'auto') {
            return { type: 'auto' };
        }
        if (toolChoice === 'none') {
            return { type: 'none' };
        }
        if (toolChoice === 'required') {
            return { type: 'any' };
        }
    }

    if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
        return {
            type: 'tool',
            name: toolChoice.function.name
        };
    }

    return { type: 'auto' };
}
