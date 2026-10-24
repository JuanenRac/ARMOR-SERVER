import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { fetchCameraPicture, previewTarget } from "../src/cameras/preview.js";
import type { CameraConnection } from "../src/cameras/model.js";
import { forgetDigestMemory } from "../src/cameras/digest.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

async function camera(handler: (request: IncomingMessage, response: ServerResponse) => void, extra: Partial<CameraConnection> = {}) {
  const server: Server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const connection: CameraConnection = { id: "cam-1", name: "Gate", host: "127.0.0.1", snapshotUrl: `http://127.0.0.1:${port}/snap.jpg`, rtspPath: "", onvifPort: port, rtspPort: 554, secrets: { username: "admin", password: "s3cret" }, ...extra };
  return { connection, port, close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

test("the picture is fetched with the camera's Basic login and returned as it came", async () => {
  forgetDigestMemory();
  const seen: (string | undefined)[] = [];
  const fake = await camera((request, response) => {
    seen.push(request.headers.authorization);
    if (request.headers.authorization !== `Basic ${Buffer.from("admin:s3cret").toString("base64")}`) { response.writeHead(401, { "WWW-Authenticate": 'Basic realm="cam"' }).end(); return; }
    response.writeHead(200, { "Content-Type": "image/jpeg" }).end(JPEG);
  });
  try {
    const picture = await fetchCameraPicture(fake.connection);
    assert.equal(picture.contentType, "image/jpeg");
    assert.deepEqual(picture.body, JPEG);
    assert.equal(seen[0], undefined, "the first request carries no login");
    assert.equal(seen.length, 2);
  } finally { await fake.close(); }
});

test("a Digest challenge is answered too", async () => {
  forgetDigestMemory();
  const fake = await camera((request, response) => {
    if (!/^Digest /.test(request.headers.authorization ?? "")) { response.writeHead(401, { "WWW-Authenticate": 'Digest realm="cam", nonce="abc123", qop="auth", algorithm=MD5' }).end(); return; }
    response.writeHead(200, { "Content-Type": "image/png" }).end(JPEG);
  });
  try {
    assert.equal((await fetchCameraPicture(fake.connection)).contentType, "image/png");
  } finally { await fake.close(); }
});

test("a camera without a login is asked without one, and a refused login is reported without the password", async () => {
  forgetDigestMemory();
  const open = await camera((_request, response) => { response.writeHead(200, { "Content-Type": "image/jpeg; charset=binary" }).end(JPEG); }, { secrets: undefined });
  try { assert.equal((await fetchCameraPicture(open.connection)).contentType, "image/jpeg"); } finally { await open.close(); }
  const closed = await camera((_request, response) => { response.writeHead(401, { "WWW-Authenticate": 'Basic realm="cam"' }).end(); });
  try {
    await assert.rejects(fetchCameraPicture(closed.connection), (error: Error) => /refused the login/.test(error.message) && !/s3cret/.test(error.message));
  } finally { await closed.close(); }
});

test("anything that is not a picture, a redirect or a huge answer is refused", async () => {
  forgetDigestMemory();
  const page = await camera((_request, response) => { response.writeHead(200, { "Content-Type": "text/html" }).end("<html></html>"); });
  try { await assert.rejects(fetchCameraPicture(page.connection), /did not answer with a picture/); } finally { await page.close(); }
  const redirect = await camera((_request, response) => { response.writeHead(302, { Location: "http://192.168.0.1/x.jpg" }).end(); });
  try { await assert.rejects(fetchCameraPicture(redirect.connection), /gave no picture/); } finally { await redirect.close(); }
  const huge = await camera((_request, response) => { response.writeHead(200, { "Content-Type": "image/jpeg" }); response.end(Buffer.alloc(4 * 1024 * 1024)); });
  try { await assert.rejects(fetchCameraPicture(huge.connection), /too large/); } finally { await huge.close(); }
});

test("the address must be http or https, carry no login and stay on the camera's host", () => {
  const base = { host: "192.168.0.50", snapshotUrl: "http://192.168.0.50/snap.jpg" };
  assert.equal(previewTarget(base).pathname, "/snap.jpg");
  for (const snapshotUrl of ["", "not a url", "ftp://192.168.0.50/x", "file:///etc/passwd", "http://admin:pw@192.168.0.50/x", "http://192.168.0.51/x", "http://evil.example/x"]) {
    assert.throws(() => previewTarget({ ...base, snapshotUrl }), /snapshot address/, snapshotUrl);
  }
});

test("a camera that does not answer is reported as unavailable", async () => {
  await assert.rejects(fetchCameraPicture({ id: "c", name: "c", host: "127.0.0.1", snapshotUrl: "http://127.0.0.1:1/snap.jpg", rtspPath: "", onvifPort: 80, rtspPort: 554 }, 1_000), /camera is unavailable/);
});
