// Prints a new age X25519 identity file to stdout (PS-007). Used once to make the DEV-ONLY key in
// infra/secrets/dev.age.key; the SOPS image has no age-keygen and there is no official age image.
// Format as age-keygen writes it: comments, then AGE-SECRET-KEY-1… (bech32 of the 32-byte scalar);
// the recipient is age1… (bech32 of the X25519 public key). Usage: node scripts/dev-age-keygen.mjs
import { generateKeyPairSync } from 'node:crypto';

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATOR[i];
  }
  return chk >>> 0;
}

function toWords(bytes) {
  const words = [];
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((acc >>> bits) & 31);
    }
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 31);
  return words;
}

/** BIP-173 bech32 (age uses bech32 without the 90-character limit). */
function bech32(hrp, bytes) {
  const words = toWords(bytes);
  const codes = [...hrp].map((c) => c.charCodeAt(0));
  const expanded = [...codes.map((c) => c >> 5), 0, ...codes.map((c) => c & 31)];
  const mod = polymod([...expanded, ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map((p) => (mod >>> (5 * (5 - p))) & 31);
  return `${hrp}1${[...words, ...checksum].map((w) => CHARSET[w]).join('')}`;
}

const { privateKey, publicKey } = generateKeyPairSync('x25519');
const secret = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
const recipient = bech32('age', pub);

process.stdout.write(
  [
    '# DEV ONLY. Synthetic local-development key, committed on purpose (T-0103, PS-007).',
    '# It decrypts only infra/secrets/dev.sops.yaml, which holds synthetic values.',
    '# Never use it, or any value it decrypts, for staging or production (SEC-5).',
    `# created: ${new Date().toISOString()}`,
    `# public key: ${recipient}`,
    bech32('age-secret-key-', secret).toUpperCase(),
    '',
  ].join('\n'),
);
process.stderr.write(`recipient: ${recipient}\n`);
