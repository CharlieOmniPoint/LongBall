import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { AccessError } from '../../../packages/application/src/access';

const JSON_LIMIT = 256 * 1024;
const UPLOAD_LIMIT = 15 * 1024 * 1024;
export interface TransportOptions {
  dispatch(request: IncomingMessage, reply: ServerResponse, body: unknown, requestId: string): Promise<void>;
  beforeParsing(request: IncomingMessage, reply: ServerResponse): void;
}
function requestId(request: IncomingMessage): string {
  const supplied = request.headers['x-request-id'];
  return typeof supplied === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(supplied) ? supplied : randomUUID();
}
/** Fastify owns routing, secure parsing, request validation and shutdown. Domain handlers retain their exact response contracts. */
export function createFastifyTransport(options: TransportOptions): FastifyInstance {
  const app: FastifyInstance = Fastify({
    logger: false,
    requestIdHeader: false,
    genReqId: requestId,
    bodyLimit: JSON_LIMIT,
    requestTimeout: 65_000,
    connectionTimeout: 0,
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    exposeHeadRoutes: false,
    routerOptions: { maxParamLength: 150 },
    frameworkErrors(_error, request, frameworkReply) {
      const reply = frameworkReply as FastifyReply;
      // Router failures precede normal hooks/errorHandler. Never echo the raw
      // address: it can contain an invitation capability or private query text.
      try { options.beforeParsing(request.raw, reply.raw); }
      catch (error) {
        if (error instanceof AccessError) return reply.code(error.status).headers({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Request-Id': request.id }).send({ code: error.code, message: error.message, requestId: request.id, retryable: false });
      }
      return reply.code(400).headers({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Request-Id': request.id }).send({ code: 'INVALID_REQUEST', message: 'Use a valid request address and headers.', requestId: request.id, retryable: false });
    },
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, allErrors: false } },
    serverFactory(handler) {
      // createApi remains synchronous and exposes native server.listen(). Every
      // request still waits for all Fastify parsers, routes and hooks to boot.
      return createServer((request, reply) => {
        void app.ready().then(() => handler(request, reply), () => {
          const id = requestId(request);
          reply.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Request-Id': id });
          reply.end(JSON.stringify({ code: 'SERVICE_UNAVAILABLE', message: 'The service is temporarily unavailable.', requestId: id, retryable: true }));
        });
      });
    },
  });
  // Existing callers start the public native listener synchronously. Register
  // its drain in Fastify's close lifecycle so shutdown also covers that path.
  app.addHook('preClose', async () => {
    if (app.server.listening) await new Promise<void>((resolve, reject) => app.server.close(error => error ? reject(error) : resolve()));
  });
  app.server.requestTimeout = 65_000;
  app.server.headersTimeout = 10_000;
  app.addHook('onRequest', async (request, reply) => {
    options.beforeParsing(request.raw, reply.raw);
    if (request.method === 'OPTIONS') return reply.code(204).send();
  });
  app.setErrorHandler((error, request, reply) => {
    const value = error as { code?: string; statusCode?: number };
    const tooLarge = value.code === 'FST_ERR_CTP_BODY_TOO_LARGE';
    const unsupported = ['FST_ERR_CTP_INVALID_MEDIA_TYPE', 'FST_ERR_CTP_INVALID_MEDIA_TYPE_CHARSET'].includes(value.code ?? '');
    const badUrl = value.code === 'FST_ERR_BAD_URL';
    const invalid = value.statusCode === 400 || value.code === 'FST_ERR_VALIDATION';
    const status = error instanceof AccessError ? error.status : tooLarge ? 413 : unsupported ? 415 : invalid ? 400 : 503;
    const code = error instanceof AccessError ? error.code : tooLarge ? 'REQUEST_TOO_LARGE' : unsupported ? 'JSON_REQUIRED' : badUrl ? 'INVALID_REQUEST' : invalid ? 'INVALID_JSON' : 'SERVICE_UNAVAILABLE';
    const message = error instanceof AccessError ? error.message : tooLarge ? 'The request exceeds the 256 KiB limit.' : unsupported ? 'Use application/json for this command.' : badUrl ? 'Use a valid request address.' : invalid ? 'A valid JSON object is required.' : 'The service is temporarily unavailable.';
    reply.code(status).type('application/json; charset=utf-8').headers({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Request-Id': request.id }).send({ code, message, requestId: request.id, retryable: status === 429 || status === 503 });
  });
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).headers({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Request-Id': request.id }).send({ code: 'NOT_FOUND', message: 'The requested object is unavailable.', requestId: request.id, retryable: false });
  });
  // JSON commands are parsed by Fastify's secure JSON reader; plain text is not
  // an alternative mutation format. Canonical command parsers run afterwards.
  app.removeContentTypeParser('text/plain');
  const dispatch = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.hijack();
    await options.dispatch(request.raw, reply.raw, request.body, request.id);
  };
  app.post('/v1/teams/:teamId/team-sheet',{bodyLimit:7*1024*1024,schema:{body:{type:'object',additionalProperties:true}}},dispatch);
  for (const url of ['/', '/*']) {
    app.route({ method: 'POST', url, schema: { body: { type: 'object', additionalProperties: true } }, handler: dispatch });
    app.route({ method: ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'], url, handler: dispatch });
  }
  // Original image bytes remain streams. Their existing authenticated manifest
  // readers enforce exact declared size and the 15 MiB cap while reading chunks.
  // Encapsulation prevents this raw parser from accepting command JSON elsewhere.
  app.register(async uploads => {
    uploads.removeAllContentTypeParsers();
    uploads.addContentTypeParser('*', (request, payload, done) => {
      const length = request.headers['content-length'];
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > UPLOAD_LIMIT)) return done(new AccessError('UPLOAD_TOO_LARGE', 413, 'The image upload exceeds its supported size.'));
      done(null, payload);
    });
    for (const url of ['/v1/teams/:teamId/media/uploads/:uploadId', '/v1/teams/:teamId/branding/uploads/:uploadId']) uploads.put(url, { bodyLimit: UPLOAD_LIMIT }, dispatch);
  });
  return app;
}
