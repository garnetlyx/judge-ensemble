/**
 * Generic retry/timeout utilities with abort-cascade support.
 *
 * Extracted from aiJudge/retry.ts for the judge-ensemble package (Phase 1).
 * No app config dependency: callers must pass explicit retry parameters.
 */

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface RetryAttemptInfo {
  attempt: number;
  maxAttempts: number;
  delay: number;
  error: string;
}

export type RetryObserver = (info: RetryAttemptInfo) => void;

/**
 * Sleep utility for delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if an error is retryable (rate limits, timeouts, temporary failures)
 */
function isRetryableError(error: unknown): boolean {
  if (!error) return false;

  const errorMessage = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const retryablePatterns = [
    'rate limit',
    'rate_limit',
    'too many requests',
    '429',
    'timeout',
    'timed out',
    'econnreset',
    'econnrefused',
    'socket hang up',
    'network error',
    'temporary',
    'overloaded',
    '503',
    '502',
    '504',
  ];

  return retryablePatterns.some(pattern => errorMessage.includes(pattern));
}

/**
 * Retry utility with exponential backoff. When parentSignal aborts, retries stop
 * immediately and the current in-flight promise's AbortController is aborted too.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions & { onRetry?: RetryObserver },
  parentSignal?: AbortSignal
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs, onRetry } = options;

  if (parentSignal?.aborted) {
    throw new Error('Aborted before retry: parent signal already aborted');
  }

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (parentSignal?.aborted) {
      throw new Error(`Aborted during retry: parent signal aborted (attempt ${attempt})`);
    }

    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (parentSignal?.aborted) {
        throw new Error(`Aborted during attempt ${attempt}: parent signal aborted`);
      }

      const isRetryable = isRetryableError(error);

      if (!isRetryable || attempt === maxAttempts) {
        throw lastError;
      }

      const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
      const jitter = Math.random() * baseDelayMs * 0.5;
      const delay = Math.min(exponentialDelay + jitter, maxDelayMs);

      onRetry?.({ attempt, maxAttempts, delay, error: lastError.message });

      await sleepInterruptible(delay, parentSignal);
    }
  }

  throw lastError;
}

function sleepInterruptible(ms: number, parentSignal?: AbortSignal): Promise<void> {
  if (!parentSignal) {
    return sleep(ms);
  }
  return new Promise((resolve, reject) => {
    if (parentSignal.aborted) {
      reject(new Error('Aborted during sleep: parent signal aborted'));
      return;
    }
    const timer = setTimeout(() => {
      parentSignal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    (timer as { unref?: () => void })?.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Aborted during sleep: parent signal aborted'));
    };
    parentSignal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Timeout utility that wraps a promise with a timeout.
 * Accepts either a pre-started Promise or a factory that receives an AbortSignal.
 * When a factory is provided, the AbortController is aborted on timeout,
 * allowing HTTP clients to cancel in-flight requests and save API credits.
 *
 * parentSignal, when provided, cascades cancellation: if the parent aborts,
 * this layer's AbortController is also aborted AND the outer race rejects
 * immediately (rather than waiting for the factory to observe the signal).
 */
export async function withTimeout<T>(
  promiseOrFactory: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  ms: number,
  timeoutMessage = 'Operation timed out',
  parentSignal?: AbortSignal
): Promise<T> {
  if (parentSignal?.aborted) {
    throw new Error('Aborted before start: parent signal already aborted');
  }

  const abortController = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout>;

  const cascadeAbort = () => {
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
  };

  let detachParent: (() => void) | null = null;
  if (parentSignal) {
    parentSignal.addEventListener('abort', cascadeAbort, { once: true });
    detachParent = () => parentSignal.removeEventListener('abort', cascadeAbort);
  }

  const promise = typeof promiseOrFactory === 'function'
    ? promiseOrFactory(abortController.signal)
    : promiseOrFactory;

  const parentAbortPromise = parentSignal
    ? new Promise<never>((_, reject) => {
      const onAbort = () => reject(new Error('Aborted: parent signal aborted'));
      parentSignal.addEventListener('abort', onAbort, { once: true });
    })
    : null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      abortController.abort();
      reject(new Error(timeoutMessage));
    }, ms);
    (timeoutId as { unref?: () => void })?.unref?.();
  });

  const racers: Array<Promise<T>> = [promise, timeoutPromise];
  if (parentAbortPromise) {
    racers.push(parentAbortPromise);
  }

  try {
    const result = await Promise.race(racers);
    clearTimeout(timeoutId!);
    if (detachParent) detachParent();
    return result;
  } catch (error) {
    clearTimeout(timeoutId!);
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
    if (detachParent) detachParent();
    throw error;
  }
}

/**
 * Categorize error for smart retry scheduling
 */
export type ErrorCategory =
  | 'rate_limit'
  | 'quota_exceeded'
  | 'auth_error'
  | 'network'
  | 'unknown';

export function categorizeError(error: unknown): ErrorCategory {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();

  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) {
    return 'rate_limit';
  }

  if (msg.includes('quota') || msg.includes('insufficient') || msg.includes('billing') ||
    msg.includes('credit') || msg.includes('exceeded') || msg.includes('limit reached')) {
    return 'quota_exceeded';
  }

  if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') ||
    (msg.includes('invalid') && msg.includes('key'))) {
    return 'auth_error';
  }

  if (msg.includes('econnrefused') || msg.includes('econnreset') || msg.includes('timeout') ||
    msg.includes('socket hang up') || msg.includes('network error')) {
    return 'network';
  }

  return 'unknown';
}
