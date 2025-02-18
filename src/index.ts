import {
  Application,
  Request,
  Status,
  Context,
} from "https://deno.land/x/oak@v10.3.0/mod.ts";
import * as jose from "https://deno.land/x/jose@v4.3.7/index.ts";
import { config } from "https://deno.land/x/dotenv@v3.2.0/mod.ts";

const app = new Application();

const X_FORWARDED_HOST = "x-forwarded-host";

const JWT_SECRET =
  Deno.env.get("JWT_SECRET") ?? config({ safe: true }).JWT_SECRET;
const DENO_ORIGIN =
  Deno.env.get("DENO_ORIGIN") ?? config({ safe: true }).DENO_ORIGIN;
const VERIFY_JWT =
  (Deno.env.get("VERIFY_JWT") ?? config({ safe: true }).VERIFY_JWT) === "true";

function getAuthToken(ctx: Context) {
  const authHeader = ctx.request.headers.get("authorization");
  if (!authHeader) {
    ctx.throw(Status.Unauthorized, "Missing authorization header");
  }
  const [bearer, token] = authHeader.split(" ");
  if (bearer !== "Bearer") {
    ctx.throw(Status.Unauthorized, `Auth header is not 'Bearer {token}'`);
  }
  return token;
}

async function verifyJWT(jwt: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const secretKey = encoder.encode(JWT_SECRET);
  try {
    await jose.jwtVerify(jwt, secretKey);
  } catch (err) {
    console.error(err);
    return false;
  }
  return true;
}

function sanitizeHeaders(headers: Headers): Headers {
  const sanitizedHeaders = new Headers();
  const headerDenyList = ["set-cookie"];

  headers.forEach((value, key) => {
    if (!headerDenyList.includes(key.toLowerCase())) {
      sanitizedHeaders.set(key, value);
    }
  });
  return sanitizedHeaders;
}

function patchedReq(req: Request): [URL, RequestInit] {
  // Parse & patch URL (preserve path and querystring)
  const url = req.url;
  const denoOrigin = new URL(DENO_ORIGIN);
  url.host = denoOrigin.host;
  url.port = denoOrigin.port;
  url.protocol = denoOrigin.protocol;
  // Patch Headers
  const xHost = url.hostname;

  return [
    url,
    {
      headers: {
        ...Object.fromEntries(req.headers.entries()),
        [X_FORWARDED_HOST]: xHost,
      },
      body: (req.hasBody
        ? req.body({ type: "stream" }).value
        : undefined) as unknown as BodyInit,
      method: req.method,
    },
  ];
}

async function relayTo(req: Request): Promise<Response> {
  const [url, init] = patchedReq(req);
  return await fetch(url, init);
}

app.use(async (ctx: Context, next: () => Promise<unknown>) => {
  try {
    await next();
  } catch (err) {
    console.error(err);
    ctx.response.body = err.message;
    ctx.response.headers.append("x-relay-error", "true");
    ctx.response.status = err.status || 500;
  }
});

app.use(async (ctx: Context, next: () => Promise<unknown>) => {
  const { request, response } = ctx;

  const supportedVerbs = ['POST', 'GET','PUT', 'PATCH', 'DELETE', 'OPTIONS'];
  if (!(supportedVerbs.includes(request.method))) {
    console.error(`${request.method} not supported`);
    return ctx.throw(
      Status.MethodNotAllowed,
      `HTTP request method not supported (supported: ${supportedVerbs.join(' ')})`
    );
  }


  if (request.method !== "OPTIONS" && VERIFY_JWT) {
    const token = getAuthToken(ctx);
    const isValidJWT = await verifyJWT(token);

    if (!isValidJWT) {
      return ctx.throw(Status.Unauthorized, "Invalid JWT");
    }
  }

  const resp = await relayTo(request);

  const sanitizedHeaders = sanitizeHeaders(resp.headers);
  if (request.method === "GET") {
    const contentTypeHeader = sanitizedHeaders.get('Content-Type');
    if (contentTypeHeader?.includes('text/html')) {
      //sanitizedHeaders.set('Content-Type', 'text/plain');
    }
  }

  response.body = resp.body;
  response.status = resp.status;
  response.headers = sanitizedHeaders;
  response.type = resp.type;

  await next();
});

if (import.meta.main) {
  const port = parseInt(Deno.args?.[0] ?? 8081);
  const hostname = "0.0.0.0";

  console.log(`Listening on http://${hostname}:${port}`);
  await app.listen({ port, hostname });
}
