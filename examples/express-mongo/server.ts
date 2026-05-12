// Minimal host app wiring mailer into Express + MongoDB.
// Run after `yarn build` at the repo root, then `yarn install` in this folder.
//
// This stub will be filled in once Phase 0 exports the Mailer class.

import express from 'express'
import { MongoClient } from 'mongodb'
import { VERSION } from 'mailery'

const app = express()
const PORT = process.env.PORT ?? 3000

app.get('/', (_req, res) => {
  res.json({ ok: true, mailery: VERSION })
})

async function main() {
  const mongo = await MongoClient.connect(process.env.MONGODB_URI ?? 'mongodb://localhost:27017/mailery-example')
  const db = mongo.db()
  // TODO (Phase 0):
  //   const mailer = await Mailer.init({ db, adapter: new MongoContactAdapter({ db, collection: 'users' }), ... })
  //   app.use('/admin/mailer', mailer.adminRouter())
  //   app.use('/m', mailer.publicRouter())
  app.listen(PORT, () => console.log(`example listening on :${PORT}`))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
