// ============================================================
// Abstract base class for all LLM providers
// ============================================================

class BaseProvider {
  /**
   * @param {object} modelConfig - Entry from models.json for this provider's model
   */
  constructor(modelConfig) {
    this.config = modelConfig;
  }

  /**
   * Validate that required API key is set. Throws if missing.
   */
  validate() {
    // Override in subclass
  }

  /**
   * Convert Anthropic-format request body to provider-native format.
   * @param {object} anthropicBody - Full POST /v1/messages body
   * @returns {object} Provider-native request payload
   */
  buildRequest(anthropicBody) {
    throw new Error("buildRequest() not implemented");
  }

  /**
   * Convert provider-native response to Anthropic-format response.
   * @param {object} nativeResp - Provider's API response
   * @param {string} modelName - Model name to report to client
   * @returns {object} Anthropic-format response
   */
  convertResponse(nativeResp, modelName) {
    throw new Error("convertResponse() not implemented");
  }

  /**
   * Stream provider response, emitting Anthropic-format SSE events.
   * @param {Stream} nativeStream - Provider's response stream
   * @param {object} res - Express response object
   * @param {string} modelName - Model name to report to client
   * @returns {Promise} Resolves when stream ends
   */
  async streamResponse(nativeStream, res, modelName) {
    throw new Error("streamResponse() not implemented");
  }

  /**
   * Get the provider's chat completions API URL.
   * @returns {string}
   */
  getApiUrl() {
    throw new Error("getApiUrl() not implemented");
  }

  /**
   * Get HTTP headers for provider API requests.
   * @returns {object}
   */
  getHeaders() {
    throw new Error("getHeaders() not implemented");
  }
}

module.exports = BaseProvider;
