import { describe, it, expect } from 'vitest'
import { extractMsgId, buildGsi2pk, buildOutboundMsgId, extractFirstInReplyTo } from '../../src/processor/message-id.js'

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

describe('buildGsi2pk', () => {
  it('constructs key with normal inputs', () => {
    expect(buildGsi2pk('acct123', 'msg@example.com')).toBe('ACCT#acct123#MSGID#msg@example.com')
  })

  it('truncates to 1024 chars when input is long', () => {
    const longId = 'x'.repeat(1100)
    const result = buildGsi2pk(longId, 'msg@example.com')
    expect(result.length).toBe(1024)
    expect(result.startsWith('ACCT#')).toBe(true)
  })

  it('constructs key with empty accountId and msgId', () => {
    expect(buildGsi2pk('', '')).toBe('ACCT##MSGID#')
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
