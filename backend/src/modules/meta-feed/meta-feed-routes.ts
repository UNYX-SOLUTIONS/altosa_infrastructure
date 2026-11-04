import { timingSafeEqual } from 'node:crypto';
import { Router, type Request } from 'express';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { buildMetaFeed, type MetaFeedScope } from './meta-feed-service';

const SCOPES: MetaFeedScope[] = ['published', 'meta', 'active', 'all'];

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function basicCredentials(
  authorization: string | undefined
): { user: string; password: string } | null {
  if (!authorization?.startsWith('Basic ')) {
    return null;
  }
  try {
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) {
      return null;
    }
    return {
      user: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

function isAuthorized(req: Request): boolean {
  const apiKey = req.header('x-api-key');
  if (apiKey && safeEqual(apiKey, env.API_KEY)) {
    return true;
  }
  if (!env.META_FEED_USER || !env.META_FEED_PASSWORD) {
    return false;
  }
  const credentials = basicCredentials(req.header('authorization'));
  if (!credentials) {
    return false;
  }
  return (
    safeEqual(credentials.user, env.META_FEED_USER) &&
    safeEqual(credentials.password, env.META_FEED_PASSWORD)
  );
}

export const metaFeedRouter = Router();

metaFeedRouter.get('/meta-catalog.csv', async (req, res, next) => {
  try {
    if (!isAuthorized(req)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Altosa Meta feed"');
      res.status(401).type('text/plain; charset=utf-8');
      res.send('No autorizado.');
      return;
    }

    const rawScope = String(req.query.scope ?? 'published');
    const scope = SCOPES.includes(rawScope as MetaFeedScope)
      ? (rawScope as MetaFeedScope)
      : null;
    if (!scope) {
      res.status(400).type('text/plain; charset=utf-8');
      res.send(`Scope inválido. Usa: ${SCOPES.join(', ')}.`);
      return;
    }

    const feed = await buildMetaFeed(scope);
    if (feed.skipped > 0) {
      logger.warn(
        {
          scope,
          skipped: feed.skipped,
          samples: feed.skippedSamples,
        },
        'Feed Meta: se omitieron variantes sin precio/imagen/link'
      );
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="altosa-meta-catalog.csv"');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.setHeader('X-Feed-Scope', feed.scope);
    res.setHeader('X-Feed-Rows', String(feed.rows));
    res.setHeader('X-Feed-Skipped', String(feed.skipped));
    res.setHeader('X-Feed-Generated-At', feed.generatedAt);
    res.send(feed.csv);
  } catch (error) {
    next(error);
  }
});
