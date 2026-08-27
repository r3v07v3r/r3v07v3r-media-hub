// Minimal mDNS (RFC 6762) wire format — just enough for one service to be
// announced and found: PTR/SRV/TXT/A records, uncompressed on the way out,
// compression-pointer-aware on the way in (real responders compress).
//
// Hand-rolled rather than a dependency on purpose: the repo's dependency
// list is deliberately short, the subset needed here is tiny and frozen by
// RFC, and an mDNS library would be the only package pulled in by either
// side of this feature. Shared between the daemon's announcer and the
// app's browser so the two cannot disagree about the encoding.

export const MDNS_ADDRESS = '224.0.0.251'
export const MDNS_PORT = 5353

export const TYPE_A = 1
export const TYPE_PTR = 12
export const TYPE_TXT = 16
export const TYPE_SRV = 33
export const CLASS_IN = 1
/** cache-flush bit set on records we are authoritative for. */
export const CLASS_IN_FLUSH = 0x8001

export interface DnsQuestion {
  name: string
  type: number
}

export interface DnsRecord {
  name: string
  type: number
  ttl: number
  /** Type-specific payload, already decoded (see decodeRecordData). */
  data: DnsRecordData
}

export type DnsRecordData =
  | { kind: 'ptr'; target: string }
  | { kind: 'srv'; priority: number; weight: number; port: number; target: string }
  | { kind: 'txt'; entries: string[] }
  | { kind: 'a'; address: string }
  | { kind: 'raw'; bytes: Uint8Array }

export interface DnsMessage {
  id: number
  isResponse: boolean
  questions: DnsQuestion[]
  answers: DnsRecord[]
  additionals: DnsRecord[]
}

// ---------------------------------------------------------------------------
// encoding

function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, '').split('.')
  const chunks: Buffer[] = []
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8')
    if (bytes.length === 0 || bytes.length > 63) throw new Error('Invalid DNS label.')
    chunks.push(Buffer.from([bytes.length]), bytes)
  }
  chunks.push(Buffer.from([0]))
  return Buffer.concat(chunks)
}

function encodeRecord(record: DnsRecord, cls: number): Buffer {
  let rdata: Buffer
  const data = record.data
  switch (data.kind) {
    case 'ptr':
      rdata = encodeName(data.target)
      break
    case 'srv': {
      const head = Buffer.alloc(6)
      head.writeUInt16BE(data.priority, 0)
      head.writeUInt16BE(data.weight, 2)
      head.writeUInt16BE(data.port, 4)
      rdata = Buffer.concat([head, encodeName(data.target)])
      break
    }
    case 'txt': {
      const chunks = data.entries.length ? data.entries : ['']
      rdata = Buffer.concat(
        chunks.map((entry) => {
          const bytes = Buffer.from(entry, 'utf8').subarray(0, 255)
          return Buffer.concat([Buffer.from([bytes.length]), bytes])
        })
      )
      break
    }
    case 'a': {
      const octets = data.address.split('.').map(Number)
      if (
        octets.length !== 4 ||
        octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
      ) {
        throw new Error('Invalid IPv4 address.')
      }
      rdata = Buffer.from(octets)
      break
    }
    case 'raw':
      rdata = Buffer.from(data.bytes)
      break
  }
  const name = encodeName(record.name)
  const head = Buffer.alloc(10)
  head.writeUInt16BE(record.type, 0)
  head.writeUInt16BE(cls, 2)
  head.writeUInt32BE(record.ttl, 4)
  head.writeUInt16BE(rdata.length, 8)
  return Buffer.concat([name, head, rdata])
}

/** An unsolicited/response announcement carrying the given records. */
export function encodeResponse(answers: DnsRecord[], additionals: DnsRecord[] = []): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0, 0) // mDNS responses use ID 0
  header.writeUInt16BE(0x8400, 2) // QR=1 (response), AA=1
  header.writeUInt16BE(0, 4)
  header.writeUInt16BE(answers.length, 6)
  header.writeUInt16BE(0, 8)
  header.writeUInt16BE(additionals.length, 10)
  return Buffer.concat([
    header,
    ...answers.map((record) => encodeRecord(record, CLASS_IN_FLUSH)),
    ...additionals.map((record) => encodeRecord(record, CLASS_IN_FLUSH))
  ])
}

/** A one-question query (what the app's browser sends). */
export function encodeQuery(name: string, type: number): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0, 0)
  header.writeUInt16BE(0, 2)
  header.writeUInt16BE(1, 4)
  const question = Buffer.concat([encodeName(name), Buffer.alloc(4)])
  question.writeUInt16BE(type, question.length - 4)
  question.writeUInt16BE(CLASS_IN, question.length - 2)
  return Buffer.concat([header, question])
}

// ---------------------------------------------------------------------------
// decoding

function readName(buffer: Buffer, offset: number): { name: string; next: number } {
  const labels: string[] = []
  let position = offset
  let next = -1
  let hops = 0
  while (position < buffer.length) {
    const length = buffer[position]
    if (length === 0) {
      if (next === -1) next = position + 1
      break
    }
    // Compression pointer: two bytes, top bits 11.
    if ((length & 0xc0) === 0xc0) {
      if (position + 1 >= buffer.length) break
      if (next === -1) next = position + 2
      position = ((length & 0x3f) << 8) | buffer[position + 1]
      if (++hops > 16) break // malformed loop guard
      continue
    }
    labels.push(buffer.subarray(position + 1, position + 1 + length).toString('utf8'))
    position += 1 + length
  }
  return { name: labels.join('.'), next: next === -1 ? position : next }
}

function decodeRecordData(
  buffer: Buffer,
  type: number,
  start: number,
  length: number
): DnsRecordData {
  const slice = buffer.subarray(start, start + length)
  switch (type) {
    case TYPE_PTR:
      return { kind: 'ptr', target: readName(buffer, start).name }
    case TYPE_SRV:
      return {
        kind: 'srv',
        priority: slice.readUInt16BE(0),
        weight: slice.readUInt16BE(2),
        port: slice.readUInt16BE(4),
        target: readName(buffer, start + 6).name
      }
    case TYPE_TXT: {
      const entries: string[] = []
      let position = 0
      while (position < slice.length) {
        const entryLength = slice[position]
        entries.push(slice.subarray(position + 1, position + 1 + entryLength).toString('utf8'))
        position += 1 + entryLength
      }
      return { kind: 'txt', entries }
    }
    case TYPE_A:
      return { kind: 'a', address: [...slice.subarray(0, 4)].join('.') }
    default:
      return { kind: 'raw', bytes: slice }
  }
}

export function decodeMessage(buffer: Buffer): DnsMessage | null {
  try {
    if (buffer.length < 12) return null
    const flags = buffer.readUInt16BE(2)
    const questionCount = buffer.readUInt16BE(4)
    const answerCount = buffer.readUInt16BE(6)
    const authorityCount = buffer.readUInt16BE(8)
    const additionalCount = buffer.readUInt16BE(10)

    let offset = 12
    const questions: DnsQuestion[] = []
    for (let index = 0; index < questionCount; index++) {
      const { name, next } = readName(buffer, offset)
      questions.push({ name, type: buffer.readUInt16BE(next) })
      offset = next + 4
    }

    const readRecords = (count: number): DnsRecord[] => {
      const records: DnsRecord[] = []
      for (let index = 0; index < count; index++) {
        const { name, next } = readName(buffer, offset)
        const type = buffer.readUInt16BE(next)
        const ttl = buffer.readUInt32BE(next + 4)
        const dataLength = buffer.readUInt16BE(next + 8)
        const dataStart = next + 10
        records.push({
          name,
          type,
          ttl,
          data: decodeRecordData(buffer, type, dataStart, dataLength)
        })
        offset = dataStart + dataLength
      }
      return records
    }

    const answers = readRecords(answerCount)
    readRecords(authorityCount) // parsed to advance the offset; not used
    const additionals = readRecords(additionalCount)

    return {
      id: buffer.readUInt16BE(0),
      isResponse: (flags & 0x8000) !== 0,
      questions,
      answers,
      additionals
    }
  } catch {
    // Multicast delivers whatever the LAN feels like; a malformed packet is
    // background noise, never an error.
    return null
  }
}
