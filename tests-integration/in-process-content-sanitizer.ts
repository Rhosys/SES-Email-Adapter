import { handler } from '../../src/isolated/content-sanitizer.js';
import type { ContentSanitizerClient, ContentSanitizeRequest, ContentSanitizeResponse } from '../../src/processor/content-sanitizer-client.js';
import { ok, err, dbError } from '../../src/errors.js';

export class InProcessContentSanitizer implements ContentSanitizerClient {
  async invoke(request: ContentSanitizeRequest) {
    const result = await handler(request);
    if (!result.success) return err(dbError(`ContentSanitizer: ${result.error.message}`));
    return ok(result as ContentSanitizeResponse);
  }
}
