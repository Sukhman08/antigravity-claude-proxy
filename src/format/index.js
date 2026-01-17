/**
 * Format Converter Module
 * Converts between Anthropic Messages API format and Google Generative AI format
 * Also provides OpenAI Chat Completions API compatibility
 */

// Re-export all from each module
export * from './request-converter.js';
export * from './response-converter.js';
export * from './content-converter.js';
export * from './schema-sanitizer.js';
export * from './thinking-utils.js';

// OpenAI compatibility converters
export * from './openai-request-converter.js';
export * from './openai-response-converter.js';
export * from './openai-streaming.js';

// Default export for backward compatibility
import { convertAnthropicToGoogle } from './request-converter.js';
import { convertGoogleToAnthropic } from './response-converter.js';
import { convertOpenAIToAnthropic } from './openai-request-converter.js';
import { convertAnthropicToOpenAI, convertAnthropicErrorToOpenAI } from './openai-response-converter.js';
import { streamOpenAIResponse, writeOpenAIStream } from './openai-streaming.js';

export default {
    convertAnthropicToGoogle,
    convertGoogleToAnthropic,
    // OpenAI compatibility
    convertOpenAIToAnthropic,
    convertAnthropicToOpenAI,
    convertAnthropicErrorToOpenAI,
    streamOpenAIResponse,
    writeOpenAIStream
};
