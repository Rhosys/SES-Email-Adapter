import { describe, it, expect } from 'vitest'
import { extractMsgId, buildSignalGsi3pk, buildOutboundMsgId, extractFirstInReplyTo, extractReferencedOutboundMsgId } from '../../src/processor/message-id.js'

describe('extractMsgId', () => {
  it.each([
    { input: '<abc@example.com>', expected: 'abc@example.com', label: 'normal angle brackets' },
    { input: 'abc@example.com', expected: 'abc@example.com', label: 'no brackets' },
    { input: '', expected: null, label: 'empty string' },
    { input: '   ', expected: null, label: 'whitespace only' },
    { input: '<first@a.com> <second@b.com>', expected: 'first@a.com', label: 'multiple angle brackets takes first' },
    { input: '<abc@example.com', expected: '<abc@example.com', label: 'malformed no closing bracket' },
  ])('$label: "$input" → $expected', ({ input, expected }) => {
    expect(extractMsgId(input)).toBe(expected)
  })
})

describe('buildSignalGsi3pk', () => {
  it('constructs key with normal inputs', () => {
    expect(buildSignalGsi3pk('acct123', 'msg@example.com')).toBe('ACCT#acct123#MSGID#msg@example.com')
  })

  it('truncates to 1024 chars when input is long', () => {
    const longId = 'x'.repeat(1100)
    const result = buildSignalGsi3pk(longId, 'msg@example.com')
    expect(result.length).toBe(1024)
    expect(result.startsWith('ACCT#')).toBe(true)
  })

  it('constructs key with empty accountId and msgId', () => {
    expect(buildSignalGsi3pk('', '')).toBe('ACCT##MSGID#')
  })
})

describe('buildOutboundMsgId', () => {
  it('formats as sesMessageId@region.amazonses.com', () => {
    expect(buildOutboundMsgId('01000190a1b2c3d4-e5f6a7b8-1234-5678-9abc-def012345678-000000', 'eu-central-1'))
      .toBe('01000190a1b2c3d4-e5f6a7b8-1234-5678-9abc-def012345678-000000@eu-central-1.amazonses.com')
  })
})

describe('extractFirstInReplyTo', () => {
  it.each([
    { input: '<abc@example.com>', expected: 'abc@example.com', label: 'normal' },
    { input: '<first@a.com> <second@b.com>', expected: 'first@a.com', label: 'multiple msg-ids takes first' },
    { input: 'abc@example.com', expected: null, label: 'no angle brackets' },
    { input: '', expected: null, label: 'empty string' },
    { input: '   ', expected: null, label: 'whitespace only' },
  ])('$label: "$input" → $expected', ({ input, expected }) => {
    expect(extractFirstInReplyTo(input)).toBe(expected)
  })
})

describe('extractReferencedOutboundMsgId', () => {
  it('prefers In-Reply-To over References', () => {
    const headers = {
      'in-reply-to': '<parent@eu-central-1.amazonses.com>',
      'references': '<root@eu-central-1.amazonses.com> <mid@eu-central-1.amazonses.com>',
    }
    expect(extractReferencedOutboundMsgId(headers)).toBe('parent@eu-central-1.amazonses.com')
  })

  it('falls back to the LAST References entry when In-Reply-To is absent', () => {
    const headers = {
      'references': '<root@eu-central-1.amazonses.com> <immediate-parent@eu-central-1.amazonses.com>',
    }
    expect(extractReferencedOutboundMsgId(headers)).toBe('immediate-parent@eu-central-1.amazonses.com')
  })

  it('resolves the real SES DSN shape — In-Reply-To is the id we sent under', () => {
    const sentMsgId = '010701a0f2a72130-9bd8ddfc-298d-4624-a2c6-ea25b3ce66a6-000000@eu-central-1.amazonses.com'
    const headers = {
      'in-reply-to': `<${sentMsgId}>`,
      'references': `<${sentMsgId}>`,
    }
    expect(extractReferencedOutboundMsgId(headers)).toBe(sentMsgId)
  })

  it('returns null when neither header is present', () => {
    expect(extractReferencedOutboundMsgId({ 'subject': 'Delivery Status Notification (Failure)' })).toBeNull()
  })

  it('returns null when References has no parseable msg-id', () => {
    expect(extractReferencedOutboundMsgId({ 'references': 'garbage without brackets' })).toBeNull()
  })
})
