// Oppstart. All konfigurasjon kommer fra miljøvariabler (se README).

import http from 'node:http';
import pg from 'pg';
import { lagApp } from './app.js';
import { lagAirtable } from './airtable.js';
import { lagSlack } from './slack.js';
import { fraPg } from './db.js';
import { migrer, normaliserEpost } from './lagring.js';

const env = process.env;
const konfig = {
  apner: env.APNER,
  frist: env.FRIST,
  adminEpost: String(env.ADMIN_EPOST ?? '').split(',').map(normaliserEpost).filter(Boolean),
  devEpost: env.DEV_EPOST,   // bare for lokal kjøring uten innlogging foran
  lenke: env.LENKE || (env.HALVNAIS_DNS_ZONE ? `https://halvaar.${env.HALVNAIS_DNS_ZONE}/` : ''),
};

const db = fraPg(new pg.Pool({
  host: env.DB_HOST, port: Number(env.DB_PORT ?? 5432), user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME,
  ssl: env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: 5,
}));
await migrer(db);

const app = lagApp({
  db, konfig,
  airtable: lagAirtable({ token: env.AIRTABLE_TOKEN, baseId: env.AIRTABLE_BASE_ID, tabell: env.AIRTABLE_TABELL }),
  slack: lagSlack({ token: env.SLACK_BOT_TOKEN }),
});

const server = http.createServer(app.handter);
const port = Number(env.PORT ?? 8080);
server.listen(port, () => console.log(`Svarsiden for runde ${app.runde} lytter på port ${port}.`));

const klokke = setInterval(app.tikk, 60_000);
app.tikk();

process.on('SIGTERM', () => {
  clearInterval(klokke);
  server.close(() => db.close().finally(() => process.exit(0)));
});
