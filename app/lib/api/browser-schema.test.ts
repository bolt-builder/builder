import { describe, expect, it } from 'vitest';
import { browserRequestSchema } from './schemas';

describe('browserRequestSchema', () => {
  it('accepts a create op with optional viewport', () => {
    // Arrange
    const input = { op: 'create', width: 1280, height: 720 };

    // Act
    const result = browserRequestSchema.safeParse(input);

    // Assert
    expect(result.success).toBe(true);
  });

  it('rejects navigate with a non-URL value', () => {
    // Arrange
    const input = { op: 'navigate', sessionId: 'abc', url: 'not a url' };

    // Act
    const result = browserRequestSchema.safeParse(input);

    // Assert
    expect(result.success).toBe(false);
  });

  it('accepts forwarded mouse and key input events', () => {
    // Arrange
    const mouse = {
      op: 'mouse',
      sessionId: 'abc',
      event: { kind: 'down', x: 10, y: 20, button: 'left', clickCount: 1 },
    };
    const key = { op: 'key', sessionId: 'abc', event: { kind: 'insertText', text: 'hello' } };

    // Act & Assert
    expect(browserRequestSchema.safeParse(mouse).success).toBe(true);
    expect(browserRequestSchema.safeParse(key).success).toBe(true);
  });

  it('rejects unknown ops and missing sessionId', () => {
    // Arrange & Act & Assert
    expect(browserRequestSchema.safeParse({ op: 'exec', sessionId: 'abc' }).success).toBe(false);
    expect(browserRequestSchema.safeParse({ op: 'reload' }).success).toBe(false);
  });
});
