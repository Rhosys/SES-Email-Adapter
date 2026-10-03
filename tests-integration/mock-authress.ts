import { createServer } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

const KID = 'test-key-1';

export interface MockAuthressServer {
  url: string;
  createToken(userId: string): Promise<string>;
  close(): void;
}

export async function startMockAuthressServer(port = 4500): Promise<MockAuthressServer> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  const publicJwk = { ...(await exportJWK(publicKey)), kid: KID, alg: 'EdDSA' };
  const issuerUrl = `http://localhost:${port}`;

  const server = createServer((req, res) => {
    if (req.url?.startsWith('/.well-known/openid-configuration/jwks')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: [publicJwk] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    url: issuerUrl,
    createToken(userId: string) {
      return new SignJWT({ sub: userId })
        .setProtectedHeader({ alg: 'EdDSA', kid: KID })
        .setIssuer(issuerUrl)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);
    },
    close() {
      server.close();
    },
  };
}
