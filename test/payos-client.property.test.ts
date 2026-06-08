import { describe, it, expect, afterEach, vi } from 'vitest'
import fc from 'fast-check'
import {
  createPaymentLink,
  confirmWebhook,
  PayOsApiError,
  type CreatePaymentLinkParams,
} from '../src/services/payments/payos-client'

/**
 * Property-based tests cho `payos-client.ts` (tầng HTTP thuần tới PayOS).
 *
 * Mock global `fetch` (vi.stubGlobal) để không gọi mạng thật và để bắt được body
 * request mà client gửi đi. Dùng `crypto.subtle` của workers pool để tự tính lại
 * chữ ký kỳ vọng một cách độc lập (KHÔNG tái dùng hàm ký nội bộ của client).
 *
 * Validates:
 *  - Property 9: PayOS request signature matches the sorted-key HMAC — Requirements 7.2
 *  - Property 10: PayOS client fails closed without leaking secrets — Requirements 7.4, 7.5
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Chuyển ArrayBuffer → chuỗi hex thường (đối chiếu độc lập với client). */
function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Tính lại chữ ký kỳ vọng theo chuẩn PayOS: HMAC-SHA256(checksumKey, canonical)
 * với canonical = các trường `amount,cancelUrl,description,orderCode,returnUrl`
 * sắp xếp theo khoá alphabet rồi nối `key=value` bằng `&`. Xây dựng độc lập từ
 * tham số gốc, không gọi vào client.
 */
async function expectedSignature(
  checksumKey: string,
  p: Pick<CreatePaymentLinkParams, 'amount' | 'cancelUrl' | 'description' | 'orderCode' | 'returnUrl'>,
): Promise<string> {
  const fields: Record<string, string | number> = {
    amount: p.amount,
    cancelUrl: p.cancelUrl,
    description: p.description,
    orderCode: p.orderCode,
    returnUrl: p.returnUrl,
  }
  const canonical = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('&')
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(checksumKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(canonical)))
}

/**
 * Generator giá trị secret đặc trưng để kiểm tra rò rỉ chắc chắn (prefix + hex đủ dài),
 * tránh false-positive khi secret là chuỗi ngắn trùng substring trong message lỗi.
 */
const secretArb = fc.hexaString({ minLength: 12, maxLength: 24 }).map((s) => `secret_${s}`)

/** Generator tham số tạo payment link hợp lệ (config non-empty, số nguyên dương). */
const validParamsArb: fc.Arbitrary<CreatePaymentLinkParams> = fc.record({
  clientId: fc.string({ minLength: 1, maxLength: 16 }).map((s) => `cid_${s}`),
  apiKey: secretArb,
  checksumKey: secretArb,
  orderCode: fc.integer({ min: 1, max: 9_999_999 }),
  amount: fc.integer({ min: 1, max: 50_000_000 }),
  description: fc.string({ minLength: 0, maxLength: 9 }),
  returnUrl: fc.webUrl(),
  cancelUrl: fc.webUrl(),
})

describe('payos-client — Property 9: request signature matches the sorted-key HMAC', () => {
  it('signature in the POST body equals HMAC-SHA256 over sorted canonical fields', async () => {
    await fc.assert(
      fc.asyncProperty(validParamsArb, async (params) => {
        let capturedBody: Record<string, unknown> | undefined
        const mockFetch = vi.fn(async (_url: unknown, init: RequestInit) => {
          capturedBody = JSON.parse(init.body as string) as Record<string, unknown>
          return new Response(
            JSON.stringify({
              code: '00',
              desc: 'success',
              data: {
                checkoutUrl: 'https://pay.payos.vn/web/abc',
                qrCode: 'qr-data',
                paymentLinkId: 'plink-123',
              },
            }),
            { status: 200 },
          )
        })
        vi.stubGlobal('fetch', mockFetch)

        const result = await createPaymentLink(params)

        // Client trả đúng dữ liệu chuẩn hoá.
        expect(result.checkoutUrl).toBe('https://pay.payos.vn/web/abc')
        expect(result.paymentLinkId).toBe('plink-123')

        // Body phải chứa signature khớp HMAC sorted-key tính độc lập.
        expect(capturedBody).toBeDefined()
        const expectedSig = await expectedSignature(params.checksumKey, params)
        expect(capturedBody!.signature).toBe(expectedSig)

        // Body mang đúng các trường tham gia ký với giá trị gốc.
        expect(capturedBody!.orderCode).toBe(params.orderCode)
        expect(capturedBody!.amount).toBe(params.amount)
        expect(capturedBody!.returnUrl).toBe(params.returnUrl)
        expect(capturedBody!.cancelUrl).toBe(params.cancelUrl)
      }),
      { numRuns: 60 },
    )
  })
})

/** Các chế độ thất bại của một lời gọi PayOS API. */
type FailureMode =
  | { kind: 'http'; status: number }
  | { kind: 'code'; code: string }
  | { kind: 'missingData' }
  | { kind: 'network' }
  | { kind: 'abort' }

/** Cài đặt mock fetch theo từng chế độ thất bại. */
function stubFetchForFailure(mode: FailureMode): void {
  const fn = vi.fn(async () => {
    switch (mode.kind) {
      case 'http':
        return new Response(JSON.stringify({ code: '00', data: {} }), { status: mode.status })
      case 'code':
        return new Response(JSON.stringify({ code: mode.code, desc: 'biz error' }), { status: 200 })
      case 'missingData':
        return new Response(JSON.stringify({ code: '00', data: {} }), { status: 200 })
      case 'network':
        throw new Error('network down')
      case 'abort': {
        const e = new Error('aborted')
        e.name = 'AbortError'
        throw e
      }
    }
  })
  vi.stubGlobal('fetch', fn)
}

const failureModeArb: fc.Arbitrary<FailureMode> = fc.oneof(
  fc.integer({ min: 400, max: 599 }).map((status) => ({ kind: 'http', status }) as FailureMode),
  fc
    .string({ minLength: 1, maxLength: 4 })
    .filter((c) => c !== '00')
    .map((code) => ({ kind: 'code', code }) as FailureMode),
  fc.constant({ kind: 'missingData' } as FailureMode),
  fc.constant({ kind: 'network' } as FailureMode),
  fc.constant({ kind: 'abort' } as FailureMode),
)

describe('payos-client — Property 10: fails closed without leaking secrets', () => {
  it('createPaymentLink throws PayOsApiError, returns no link, and never leaks secrets', async () => {
    await fc.assert(
      fc.asyncProperty(validParamsArb, failureModeArb, async (params, mode) => {
        stubFetchForFailure(mode)

        let thrown: unknown
        let returned: unknown
        try {
          returned = await createPaymentLink(params)
        } catch (e) {
          thrown = e
        }

        // KHÔNG được trả về link.
        expect(returned).toBeUndefined()
        // Phải ném đúng loại lỗi PayOsApiError.
        expect(thrown).toBeInstanceOf(PayOsApiError)
        const message = (thrown as PayOsApiError).message
        // Thông điệp lỗi KHÔNG chứa apiKey/checksumKey (R7.5).
        expect(message.includes(params.apiKey)).toBe(false)
        expect(message.includes(params.checksumKey)).toBe(false)
      }),
      { numRuns: 80 },
    )
  })

  it('confirmWebhook throws PayOsApiError and never leaks secrets on failure', async () => {
    const webhookFailureArb: fc.Arbitrary<FailureMode> = fc.oneof(
      fc.integer({ min: 400, max: 599 }).map((status) => ({ kind: 'http', status }) as FailureMode),
      fc
        .string({ minLength: 1, maxLength: 4 })
        .filter((c) => c !== '00')
        .map((code) => ({ kind: 'code', code }) as FailureMode),
      fc.constant({ kind: 'network' } as FailureMode),
      fc.constant({ kind: 'abort' } as FailureMode),
    )

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          clientId: fc.string({ minLength: 1, maxLength: 16 }).map((s) => `cid_${s}`),
          apiKey: secretArb,
          webhookUrl: fc.webUrl(),
        }),
        webhookFailureArb,
        async (params, mode) => {
          stubFetchForFailure(mode)

          let thrown: unknown
          try {
            await confirmWebhook(params)
          } catch (e) {
            thrown = e
          }

          expect(thrown).toBeInstanceOf(PayOsApiError)
          const message = (thrown as PayOsApiError).message
          expect(message.includes(params.apiKey)).toBe(false)
        },
      ),
      { numRuns: 60 },
    )
  })
})
