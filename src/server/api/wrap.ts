/**
 * Async handler wrapper for the *public* router.
 *
 * The admin router's `asyncHandler` (`api/admin.ts`) is a plain `.catch(next)`,
 * which is right there: every admin handler computes first and responds last, so
 * a rejection always arrives before any header is written and Express can turn
 * it into a clean JSON 500.
 *
 * The public router cannot use that. `/open`, `POST /unsub` and `/webhooks` all
 * respond *first* and do their work after (INVARIANT 8 — never make a mail
 * client or a provider wait on our database). By the time those handlers can
 * reject, `res.headersSent` is already true, and forwarding post-headers makes
 * Express destroy the socket underneath a response the client has already been
 * promised.
 *
 * So this is a log-and-swallow wrapper, ported from featureboard's
 * `src/server/routes/wrap.js`, with one deliberate difference: featureboard
 * forwards with `next(err)` on the `headersSent` branch, and here that branch
 * only logs. See issue #5 — every public route is unauthenticated, and the
 * failure mode being fixed is precisely "a rejected promise in a public route
 * takes down the host process".
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express'

/**
 * Minimal structured-logger shape, compatible with pino/bunyan-style loggers
 * (`logger.error(fields, message)`). Every method is optional, so `{}` is a
 * valid silent logger and a bare `console` is not accidentally accepted with
 * mismatched argument order.
 */
export interface RouteLogger {
  error?: (fields: Record<string, unknown>, msg?: string) => void
  warn?: (fields: Record<string, unknown>, msg?: string) => void
  /**
   * Routine, high-volume telemetry — currently only "an unsigned (pre-signing)
   * tracking URL was accepted in grace mode", which is one line per legacy open
   * and is not a fault. Kept off `warn` deliberately so it can be routed or
   * dropped separately from things that are.
   */
  info?: (fields: Record<string, unknown>, msg?: string) => void
}

/**
 * Default logger — preserves the `console.error('mailery: …', details)` output
 * this package emitted before the `logger` option existed, so hosts that don't
 * pass one see no change.
 */
export const consoleRouteLogger: RouteLogger = {
  error(fields, msg) {
    console.error(msg ?? 'mailery: request failed', fields)
  },
  warn(fields, msg) {
    console.warn(msg ?? 'mailery: request warning', fields)
  },
  info(fields, msg) {
    console.info(msg ?? 'mailery: request', fields)
  },
}

export type AsyncRouteHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => unknown | Promise<unknown>

/**
 * Wrap a public route handler so a rejection can never become an unhandled
 * promise rejection (which, under Node's default `--unhandled-rejections=throw`,
 * takes the whole host application down — an unauthenticated DoS).
 *
 * Rejection handling:
 *   - always log, with the request path
 *   - headers already sent → swallow; the client has its response already
 *   - otherwise → a plain 500
 */
export function wrap(logger: RouteLogger, handler: AsyncRouteHandler): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await handler(req, res, next)
    } catch (err) {
      logger.error?.({ err, path: req.originalUrl }, 'mailery: request failed')
      if (res.headersSent) return
      res.status(500).json({ error: 'internal_error' })
    }
  }
}
