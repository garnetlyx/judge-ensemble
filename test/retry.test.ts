/**
 * Tests for judge-ensemble retry/timeout utilities (generic module).
 */
import { describe, it, expect, vi } from 'vitest';
import { withTimeout, withRetry, categorizeError, RetryOptions } from '../src/retry';

const OPTS = (o: Partial<RetryOptions> = {}): RetryOptions => ({
  maxAttempts: 3,
  baseDelayMs: 10,
  maxDelayMs: 100,
  ...o,
});

describe('withRetry', () => {
  it('returns result on first attempt success', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await withRetry(fn, OPTS());
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable error and succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('429 Too Many Requests'))
      .mockResolvedValue('success after retry');
    const result = await withRetry(fn, OPTS());
    expect(result).toBe('success after retry');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws immediately on non-retryable error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Invalid API key'));
    await expect(withRetry(fn, OPTS())).rejects.toThrow('Invalid API key');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after max attempts on retryable error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('rate limit exceeded'));
    await expect(withRetry(fn, OPTS({ maxAttempts: 2 }))).rejects.toThrow('rate limit exceeded');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('handles non-Error thrown values', async () => {
    const fn = vi.fn().mockRejectedValue('string error');
    await expect(withRetry(fn, OPTS({ maxAttempts: 1 }))).rejects.toThrow('string error');
  });

  it('retries on timeout errors', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('Request timed out'))
      .mockResolvedValue('recovered');
    const result = await withRetry(fn, OPTS());
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on network errors', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue('finally');
    const result = await withRetry(fn, OPTS({ maxAttempts: 4, baseDelayMs: 5 }));
    expect(result).toBe('finally');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('retries on 503 errors', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValue('back up');
    const result = await withRetry(fn, OPTS({ baseDelayMs: 5, maxDelayMs: 50 }));
    expect(result).toBe('back up');
  });

  it('throws when maxAttempts is 0 (defensive edge case)', async () => {
    const fn = vi.fn().mockResolvedValue('never called');
    await expect(withRetry(fn, OPTS({ maxAttempts: 0 }))).rejects.toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it('treats falsy thrown value as non-retryable', async () => {
    const fn = vi.fn().mockRejectedValue(null);
    await expect(withRetry(fn, OPTS())).rejects.toThrow('null');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses exponential backoff', async () => {
    const startTime = Date.now();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue('ok');
    await withRetry(fn, OPTS({ baseDelayMs: 50, maxDelayMs: 1000 }));
    const elapsed = Date.now() - startTime;
    expect(elapsed).toBeGreaterThanOrEqual(30);
  });

  it('reports retries through onRetry observer', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('rate limit exceeded'))
      .mockResolvedValue('ok');

    await withRetry(fn, OPTS(), undefined);
    // sanity: without observer, no crash

    const fn2 = vi.fn()
      .mockRejectedValueOnce(new Error('rate limit exceeded'))
      .mockResolvedValue('ok');
    await withRetry(fn2, { ...OPTS(), onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith({
      attempt: 1,
      maxAttempts: 3,
      delay: expect.any(Number),
      error: 'rate limit exceeded',
    });
  });
});

describe('withRetry parentSignal cascade', () => {
  it('rejects immediately when parentSignal is already aborted', async () => {
    const fn = vi.fn().mockResolvedValue('never');
    const controller = new AbortController();
    controller.abort();

    await expect(withRetry(fn, OPTS(), controller.signal))
      .rejects.toThrow('parent signal already aborted');
    expect(fn).not.toHaveBeenCalled();
  });

  it('aborts between attempts when parentSignal fires during sleep', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const fn = vi.fn().mockImplementation(() => {
      attempts++;
      if (attempts === 1) {
        setTimeout(() => controller.abort(), 5);
        throw new Error('rate limit exceeded');
      }
      return Promise.resolve('ok');
    });

    await expect(withRetry(fn, OPTS({ baseDelayMs: 80, maxDelayMs: 200 }), controller.signal))
      .rejects.toThrow('parent signal aborted');
    expect(attempts).toBe(1);
  });

  it('propagates parentSignal abort that fires mid-attempt', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const fn = vi.fn().mockImplementation(() => {
      attempts++;
      if (attempts === 2) {
        controller.abort();
      }
      throw new Error('503 Service Unavailable');
    });

    await expect(withRetry(fn, OPTS({ maxAttempts: 5, baseDelayMs: 5, maxDelayMs: 20 }), controller.signal))
      .rejects.toThrow('parent signal aborted');
    expect(attempts).toBe(2);
  });
});

describe('withTimeout', () => {
  it('resolves when promise completes before timeout', async () => {
    const result = await withTimeout(Promise.resolve('success'), 1000, 'Should not time out');
    expect(result).toBe('success');
  });

  it('rejects when promise takes longer than timeout', async () => {
    const slowPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve('too late'), 500);
    });
    await expect(withTimeout(slowPromise, 50, 'Custom timeout message'))
      .rejects.toThrow('Custom timeout message');
  });

  it('uses default timeout message', async () => {
    const slowPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve('too late'), 500);
    });
    await expect(withTimeout(slowPromise, 50)).rejects.toThrow('Operation timed out');
  });

  it('propagates errors from the original promise', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('Original error')), 1000)
    ).rejects.toThrow('Original error');
  });

  it('handles zero timeout', async () => {
    const promise = new Promise<string>(() => { /* never resolves */ });
    await expect(withTimeout(promise, 0, 'Zero timeout')).rejects.toThrow('Zero timeout');
  });

  it('clears timeout when promise resolves', async () => {
    const result = await withTimeout(Promise.resolve(42), 10000);
    expect(result).toBe(42);
  });

  it('clears timeout when promise rejects', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('fail')), 10000)
    ).rejects.toThrow('fail');
  });

  it('accepts a factory function and passes AbortSignal', async () => {
    let receivedSignal: AbortSignal | undefined;
    const factory = (signal: AbortSignal) => {
      receivedSignal = signal;
      return Promise.resolve('factory result');
    };

    const result = await withTimeout(factory, 1000);
    expect(result).toBe('factory result');
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(false);
  });

  it('aborts the signal when factory promise times out', async () => {
    let receivedSignal: AbortSignal | undefined;
    const factory = (signal: AbortSignal) => {
      receivedSignal = signal;
      return new Promise<string>((resolve) => {
        setTimeout(() => resolve('too late'), 500);
      });
    };

    await expect(withTimeout(factory, 50, 'Timed out with abort'))
      .rejects.toThrow('Timed out with abort');
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(true);
  });

  it('aborts the signal when factory promise rejects before timeout', async () => {
    let receivedSignal: AbortSignal | undefined;
    const factory = (signal: AbortSignal) => {
      receivedSignal = signal;
      return Promise.reject(new Error('factory error'));
    };

    await expect(withTimeout(factory, 1000)).rejects.toThrow('factory error');
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(true);
  });

  it('does not abort the signal when factory resolves successfully', async () => {
    let receivedSignal: AbortSignal | undefined;
    const factory = (signal: AbortSignal) => {
      receivedSignal = signal;
      return Promise.resolve('ok');
    };

    await withTimeout(factory, 1000);
    expect(receivedSignal!.aborted).toBe(false);
  });

  it('allows factory to observe abort and cancel pending work', async () => {
    let wasAborted = false;
    const factory = (signal: AbortSignal) => {
      return new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve('too late'), 500);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          wasAborted = true;
        });
      });
    };

    await expect(withTimeout(factory, 50, 'Timed out')).rejects.toThrow('Timed out');
    expect(wasAborted).toBe(true);
  });
});

describe('withTimeout parentSignal cascade', () => {
  it('aborts immediately when parentSignal is already aborted', async () => {
    let factoryInvoked = false;
    const controller = new AbortController();
    controller.abort();
    const factory = (_signal: AbortSignal) => {
      factoryInvoked = true;
      return new Promise<string>(() => {});
    };

    await expect(
      withTimeout(factory, 1000, 'Should not reach', controller.signal)
    ).rejects.toThrow('parent signal already aborted');
    expect(factoryInvoked).toBe(false);
  });

  it('cascades abort to factory signal when parent aborts mid-flight', async () => {
    let receivedSignal: AbortSignal | undefined;
    const parent = new AbortController();
    const factory = (signal: AbortSignal) => {
      receivedSignal = signal;
      return new Promise<string>(() => {});
    };

    const timeoutPromise = withTimeout(factory, 5000, 'Long timeout', parent.signal);
    setTimeout(() => parent.abort(), 20);

    await expect(timeoutPromise).rejects.toThrow();
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(true);
  });

  it('cleans up parent listener after successful resolution', async () => {
    const parent = new AbortController();
    const removeSpy = vi.spyOn(EventTarget.prototype, 'removeEventListener');
    const factory = (_signal: AbortSignal) => Promise.resolve('ok');

    await withTimeout(factory, 1000, 'irrelevant', parent.signal);

    expect(removeSpy).toHaveBeenCalled();
    removeSpy.mockRestore();
  });
});

describe('categorizeError edge cases', () => {
  it('handles Error with empty message', () => {
    expect(categorizeError(new Error(''))).toBe('unknown');
  });

  it('handles number as error', () => {
    expect(categorizeError(429)).toBe('rate_limit');
  });

  it('handles boolean as error', () => {
    expect(categorizeError(false)).toBe('unknown');
  });

  it('prioritizes rate_limit over network for timeout-like messages', () => {
    expect(categorizeError(new Error('429 timeout'))).toBe('rate_limit');
  });

  it('detects credit-related quota errors', () => {
    expect(categorizeError(new Error('Insufficient credit balance'))).toBe('quota_exceeded');
  });
});
